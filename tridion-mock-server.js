/**
 * Tridion Sites Mock Server v2
 *
 * A standalone, zero-dependency Node.js server simulating the Tridion Sites Core Service REST API.
 * Uses ONLY Node.js built-in modules (http, url, crypto). No npm install required.
 *
 * Supported Tool Categories:
 *   - Auth:            /access-management/connect/token
 *   - Publications:    getPublications, getApprovalStatuses, getTargetTypes, getMultimediaTypes,
 *                      getPublicationTypes, getProcessDefinitions, getSchemaLinks, getCategories,
 *                      getClassificationKeywordsForCategory, getUsers, getUserProfile
 *   - Items:           getItem, bulkReadItems, getItemsInContainer, getItemHistory, getPublishInfo,
 *                      getLockedItems, getDependencyGraph, getRelatedBluePrintItems, getUsedByHistory
 *   - CRUD:            createItem (Folder, SG, Category, Keyword), createComponent, createPage,
 *                      updateContent, updateMetadata, updateItemProperties, deleteItem
 *   - BluePrint:       localizeItem, unlocalizeItem, promoteItem, demoteItem
 *   - Workflow:        checkOutItem, checkInItem, undoCheckOutItem
 *   - Publish:         publish (creates mock transaction), unpublish, getPublishTransactions
 *   - Search:          search (/api/v3.0/system/search)
 *   - Classify:        classify (/items/{id}/classify), getItemsClassifiedByKeyword
 *
 * Usage: node tridion-mock-server.js [port=8081]
 */

import http from 'node:http';
import { URL } from 'node:url';
import crypto from 'node:crypto';

const PORT = parseInt(process.argv[2] || '8081', 10);

// ============================================================
// --- TYPE HELPERS ---
// ============================================================

const ITEM_TYPE = {
    Folder: 2,
    StructureGroup: 4,
    Schema: 8,
    Component: 16,
    Page: 64,
    Publication: 1,
    ComponentTemplate: 32,
    PageTemplate: 128,
    TemplateBuildingBlock: 2048,
    Category: 512,
    Keyword: 1024,
    Bundle: 8192,
    ProcessInstance: 131072,
    ProcessDefinition: 131074,
};

const ITEM_TYPE_NAME = Object.fromEntries(Object.entries(ITEM_TYPE).map(([k, v]) => [v, k]));

// ============================================================
// --- BLUEPRINT HIERARCHY ---
// ============================================================

const publications = [
    {
        Id: 'tcm:0-1-1', Title: '010 System Master', type: 'Publication', '$type': 'Publication',
        PublicationUrl: '/', PublicationPath: 'C:\\tridion\\pub1',
        RootFolder: { '$type': 'Link', IdRef: 'tcm:1-2-2', Title: 'Root Folder' },
        RootStructureGroup: { '$type': 'Link', IdRef: 'tcm:1-4-4', Title: 'Root SG' },
        BluePrintInfo: { '$type': 'BlueprintInfo', IsShared: false, IsLocalized: false, OwningRepository: { '$type': 'Link', IdRef: 'tcm:0-1-1' } }
    },
    {
        Id: 'tcm:0-5-1', Title: '050 Content Master', type: 'Publication', '$type': 'Publication',
        PublicationUrl: '/content', PublicationPath: 'C:\\tridion\\pub5',
        Parents: [{ '$type': 'Link', IdRef: 'tcm:0-1-1', Title: '010 System Master' }],
        RootFolder: { '$type': 'Link', IdRef: 'tcm:5-2-2', Title: 'Root Folder' },
        RootStructureGroup: { '$type': 'Link', IdRef: 'tcm:5-4-4', Title: 'Root SG' },
        BluePrintInfo: { '$type': 'BlueprintInfo', IsShared: false, IsLocalized: false, OwningRepository: { '$type': 'Link', IdRef: 'tcm:0-5-1' } }
    },
    {
        Id: 'tcm:0-10-1', Title: '100 Website EN', type: 'Publication', '$type': 'Publication',
        PublicationUrl: '/en', PublicationPath: 'C:\\tridion\\pub10',
        Parents: [{ '$type': 'Link', IdRef: 'tcm:0-5-1', Title: '050 Content Master' }],
        RootFolder: { '$type': 'Link', IdRef: 'tcm:10-2-2', Title: 'Root Folder' },
        RootStructureGroup: { '$type': 'Link', IdRef: 'tcm:10-4-4', Title: 'Root SG' },
        BluePrintInfo: { '$type': 'BlueprintInfo', IsShared: false, IsLocalized: false, OwningRepository: { '$type': 'Link', IdRef: 'tcm:0-10-1' } }
    },
];

// Publication numeric ID -> parent numeric pub IDs (ordered: closest first)
const dbHierarchy = {
    '1': [],
    '5': ['1'],
    '10': ['5', '1'],
};

// ============================================================
// --- IN-MEMORY DATABASE ---
// ============================================================

/**
 * Primary store. Key = "itemId-itemType" (e.g. "123-16").
 * Value = { owningPub: string, localizations: { [pubId]: itemObject } }
 */
const db = new Map();

/** Publish state: Map<tcmUri, [{ TargetType, PublishedAt, TransactionId }]> */
const publishState = new Map();

/** Publish transactions: Map<transactionId, { ...txData }> */
const publishTransactions = new Map();

/** Lock state: Map<tcmUri, { LockType, LockUser }> */
const lockState = new Map();

/** Keyword classification: Map<tcmUri, Set<keywordUri>> */
const classificationState = new Map();

/** Activity instances: Map<id, { ...activityData }> */
const activityInstances = new Map();

const seedActivities = () => {
    const actId = 'tcm:0-5001-131072';
    activityInstances.set(actId, {
        Id: actId,
        Title: 'Review About Us Changes',
        ActivityInstanceStatus: 'Assigned',
        ActivityType: 'Manual',
        Assignee: { '$type': 'Link', IdRef: 'tcm:0-1-65546', Title: 'Administrator' },
        Owner: { '$type': 'Link', IdRef: 'tcm:0-1-65546', Title: 'Administrator' },
        WorkItem: { '$type': 'Link', IdRef: 'tcm:10-123-16', Title: 'About Us' },
        WorkflowProcess: { '$type': 'Link', IdRef: 'tcm:0-1-131072', Title: 'Default Workflow' },
        CreationDate: now()
    });
};

// ============================================================
// --- FACTORY HELPERS ---
// ============================================================

const now = () => new Date().toISOString();

seedActivities();

/**
 * Hydrates a Schema item's fields and metadata fields with default boolean properties
 * to ensure verbose responses (IsLocalizable, IsPublishable, IsIndexable).
 */
const hydrateSchemaFields = (schema) => {
    const hydrateFields = (fieldsDict) => {
        if (!fieldsDict || typeof fieldsDict !== 'object') return;
        
        // Dictionary structure: { '$type': '...', 'FieldName': { ...fieldData } }
        for (const fieldName in fieldsDict) {
            if (fieldName.startsWith('$')) continue;
            
            const field = fieldsDict[fieldName];
            if (field && typeof field === 'object') {
                if (field.IsLocalizable === undefined) field.IsLocalizable = true;
                if (field.IsPublishable === undefined) field.IsPublishable = true;
                if (field.IsIndexable === undefined) field.IsIndexable = true;
                
                // Recursively handle embedded fields
                if (field.EmbeddedFields) hydrateFields(field.EmbeddedFields);
            }
        }
    };

    if (schema.Fields) hydrateFields(schema.Fields);
    if (schema.MetadataFields) hydrateFields(schema.MetadataFields);
};

const createBaseItem = (id, typeNum, title, pubId, extra = {}) => {
    const itemType = ITEM_TYPE_NAME[typeNum] || 'Item';
    const base = {
        '$type': itemType,
        Id: `tcm:${pubId}-${id}-${typeNum}`,
        Title: title,
        type: itemType,
        ItemType: typeNum,
        BluePrintInfo: {
            '$type': 'BlueprintInfo',
            OwningRepository: { '$type': 'Link', IdRef: `tcm:0-${pubId}-1`, Title: publications.find(p => p.Id === `tcm:0-${pubId}-1`)?.Title || `Pub ${pubId}` },
            IsShared: false,
            IsLocalized: false,
            PrimaryBluePrintParentItem: { '$type': 'Link', IdRef: `tcm:0-${pubId}-1` }
        },
        VersionInfo: {
            '$type': 'LimitedVersionInfo',
            Version: 1,
            Revision: 0,
            CreationDate: now(),
            RevisionDate: now()
        },
        LocationInfo: {
            '$type': 'LocationInfo',
            ContextRepository: { '$type': 'Link', IdRef: `tcm:0-${pubId}-1`, Title: publications.find(p => p.Id === `tcm:0-${pubId}-1`)?.Title || `Pub ${pubId}` },
        },
        LockInfo: {
            '$type': 'LockInfo',
            LockType: 'None',
            LockUser: null
        },
        ...extra,
    };

    // Schema-specific logic
    if (typeNum === 8) {
        if (!base.Purpose) base.Purpose = 'Component';
        if (base.Purpose === 'Region' && !base.RegionDefinition) {
            base.RegionDefinition = {
                '$type': 'RegionDefinition',
                ComponentPresentationConstraints: [],
                DefaultComponentPresentations: [],
                IsLocalizable: true,
                NestedRegions: []
            };
        }
    }

    // Bundle-specific logic
    if (typeNum === 8192) {
        if (!base.Items) base.Items = [];
        if (!base.TypeSchema) {
            base.TypeSchema = { '$type': 'Link', IdRef: 'tcm:0-2-8', Title: 'Bundle' };
        }
    }

    return base;
};

const dbPut = (itemId, typeNum, owningPub, localizationsObj) => {
    db.set(`${itemId}-${typeNum}`, { owningPub, localizations: localizationsObj });
};

// ============================================================
// --- SEED DATA ---
// ============================================================

const initDb = () => {
    // 1. Root Folders (owned by System Master, shared down)
    dbPut(2, 2, '1', {
        '1': createBaseItem(2, 2, 'Root Folder', '1'),
    });

    // 2. Root Structure Groups
    dbPut(4, 4, '1', {
        '1': createBaseItem(4, 4, 'Root SG', '1'),
    });

    // 3. Embedded Schema: Address
    dbPut(102, 8, '5', {
        '5': createBaseItem(102, 8, 'Address', '5', {
            Purpose: 'Embedded',
            RootElementName: 'Address',
            Fields: {
                '$type': 'FieldsDefinitionDictionary',
                'Street': { '$type': 'SingleLineTextFieldDefinition', Name: 'Street', MinOccurs: 1, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                'City':   { '$type': 'SingleLineTextFieldDefinition', Name: 'City',   MinOccurs: 1, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                'Zip':    { '$type': 'SingleLineTextFieldDefinition', Name: 'Zip',    MinOccurs: 0, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
            }
        })
    });

    // 4. Content Folder in Content Master
    dbPut(10, 2, '5', {
        '5': createBaseItem(10, 2, 'Building Blocks', '5', {
            MetadataSchema: { '$type': 'Link', IdRef: 'tcm:5-101-8', Title: 'SEO Metadata' },
            Metadata: {
                MetaTitle: 'Building Blocks Metadata',
                MetaDescription: 'A container for content master items.',
                Priority: 10,
                ExpiryDate: '2026-12-31T00:00:00Z'
            }
        }),
    });

    // 5. Structure Group in Website
    dbPut(20, 4, '10', {
        '10': createBaseItem(20, 4, 'Home', '10', { StructureGroupId: 'tcm:10-20-4' }),
    });

    // 6. Article Schema (Enhanced with Embedded and Diverse Types)
    dbPut(100, 8, '5', {
        '5': createBaseItem(100, 8, 'Article', '5', {
            Purpose: 'Component',
            RootElementName: 'Article',
            Fields: {
                '$type': 'FieldsDefinitionDictionary',
                'Headline':    { '$type': 'SingleLineTextFieldDefinition', Name: 'Headline', MinOccurs: 1, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                'Body':        { '$type': 'MultiLineTextFieldDefinition',  Name: 'Body',     MinOccurs: 0, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                'Image':       { '$type': 'MultimediaLinkFieldDefinition', Name: 'Image',    MinOccurs: 0, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true,
                                 AllowedMimeTypes: ['image/jpeg', 'image/png'] },
                'AuthorInfo':  { '$type': 'EmbeddedSchemaFieldDefinition', Name: 'AuthorInfo', MinOccurs: 0, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true,
                                 EmbeddedSchema: { '$type': 'Link', IdRef: 'tcm:5-102-8', Title: 'Address' },
                                 EmbeddedFields: {
                                    '$type': 'FieldsDefinitionDictionary',
                                    'Street': { '$type': 'SingleLineTextFieldDefinition', Name: 'Street', IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                                    'City':   { '$type': 'SingleLineTextFieldDefinition', Name: 'City', IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                                    'Zip':    { '$type': 'SingleLineTextFieldDefinition', Name: 'Zip', IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                                 }
                               },
                'PageCount':   { '$type': 'NumberFieldDefinition', Name: 'PageCount', MinOccurs: 0, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                'CreatedDate': { '$type': 'DateFieldDefinition',   Name: 'CreatedDate', MinOccurs: 0, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
            },
            MetadataFields: { '$type': 'FieldsDefinitionDictionary' },
        }),
    });

    // 7. SEO Metadata Schema (Enhanced)
    dbPut(101, 8, '5', {
        '5': createBaseItem(101, 8, 'SEO Metadata', '5', {
            SchemaPurpose: 'Metadata',
            RootElementName: 'SEOMetadata',
            Fields: { '$type': 'FieldsDefinitionDictionary' },
            MetadataFields: {
                '$type': 'FieldsDefinitionDictionary',
                'MetaTitle':       { '$type': 'SingleLineTextFieldDefinition', Name: 'MetaTitle',       MinOccurs: 0, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                'MetaDescription': { '$type': 'MultiLineTextFieldDefinition',  Name: 'MetaDescription', MinOccurs: 0, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                'Priority':        { '$type': 'NumberFieldDefinition',         Name: 'Priority',        MinOccurs: 0, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
                'ExpiryDate':      { '$type': 'DateFieldDefinition',          Name: 'ExpiryDate',      MinOccurs: 0, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true },
            },
        }),
    });

    // 8. Multimedia Schema: Image Asset
    dbPut(103, 8, '5', {
        '5': createBaseItem(103, 8, 'Image Asset', '5', {
            SchemaPurpose: 'Multimedia',
            RootElementName: 'ImageAsset',
            IsMultimedia: true,
            AllowedMultimediaTypes: [{ '$type': 'Link', IdRef: 'tcm:0-1-197', Title: 'JPEG Image' }],
            Fields: { '$type': 'FieldsDefinitionDictionary' },
            MetadataFields: { '$type': 'FieldsDefinitionDictionary' },
        })
    });

    // 6a. Region Schema
    dbPut(900, 8, '5', {
        '5': createBaseItem(900, 8, 'Main Page Region', '5', {
            Purpose: 'Region',
            RegionDefinition: {
                '$type': 'RegionDefinition',
                ComponentPresentationConstraints: [
                    {
                        '$type': 'OccurrenceConstraint',
                        MaxOccurs: 5,
                        MinOccurs: 0
                    }
                ],
                DefaultComponentPresentations: [],
                IsLocalizable: true,
                NestedRegions: []
            }
        })
    });

    // 6b. Bundle Schema
    dbPut(901, 8, '5', {
        '5': createBaseItem(901, 8, 'Campaign Bundle Schema', '5', {
            Purpose: 'Bundle',
            MetadataFields: {
                '$type': 'FieldsDefinitionDictionary',
                'CampaignID': { '$type': 'SingleLineTextFieldDefinition', Name: 'CampaignID', MinOccurs: 1, MaxOccurs: 1, IsLocalizable: true, IsPublishable: true, IsIndexable: true }
            }
        })
    });

    // 6c. Bundle
    dbPut(902, 8192, '5', {
        '5': createBaseItem(902, 8192, 'Q2 Launch Bundle', '5', {
            TypeSchema: { '$type': 'Link', IdRef: 'tcm:5-901-8', Title: 'Campaign Bundle Schema' },
            Items: [
                { '$type': 'Link', IdRef: 'tcm:5-123-16', Title: 'About Us' },
                { '$type': 'Link', IdRef: 'tcm:10-456-64', Title: 'Home Page' }
            ]
        })
    });

    // 9. Page Template (Enhanced with Region Schema simulation)
    dbPut(99, 128, '5', {
        '5': createBaseItem(99, 128, 'Standard Page', '5', {
            OutputFormat: 'HTML Fragment',
            AllowOnPage: true,
        }),
    });

    // 10. Component Template
    dbPut(98, 32, '5', {
        '5': createBaseItem(98, 32, 'Article CT', '5', {
            OutputFormat: 'HTML Fragment',
            AllowOnPage: true,
        }),
    });

    // 11. Multimedia Component: Banner
    dbPut(500, 16, '5', {
        '5': createBaseItem(500, 16, 'Hero Banner', '5', {
            Schema: { '$type': 'Link', IdRef: 'tcm:5-103-8', Title: 'Image Asset' },
            LocationInfo: {
                '$type': 'LocationInfo',
                ContextRepository: { '$type': 'Link', IdRef: 'tcm:0-5-1' },
                OrganizationalItem: { '$type': 'Link', IdRef: 'tcm:5-10-2' },
            },
            BinaryContent: {
                '$type': 'BinaryContent',
                FileSize: 102400,
                MimeType: 'image/jpeg',
                FileName: 'banner.jpg',
                FileExtension: 'jpg',
                MultimediaType: { '$type': 'Link', IdRef: 'tcm:0-1-197', Title: 'JPEG Image' }
            }
        })
    });

    // 12. Component: About Us
    dbPut(123, 16, '5', {
        '5': createBaseItem(123, 16, 'About Us', '5', {
            Schema: { '$type': 'Link', IdRef: 'tcm:5-100-8', Title: 'Article' },
            LocationInfo: {
                '$type': 'LocationInfo',
                ContextRepository: { '$type': 'Link', IdRef: 'tcm:0-5-1', Title: '050 Content Master' },
                OrganizationalItem: { '$type': 'Link', IdRef: 'tcm:5-10-2', Title: 'Building Blocks' },
            },
            Content: {
                Headline: 'Welcome to our Master site',
                Body: 'This is the master body text.',
                PageCount: 1,
                CreatedDate: '2026-04-15T00:00:00Z',
                AuthorInfo: {
                    Street: 'Main St',
                    City: 'Amsterdam',
                    Zip: '1011'
                }
            },
        }),
    });

    // 13. Component: News Item
    dbPut(124, 16, '5', {
        '5': createBaseItem(124, 16, 'News Item', '5', {
            Schema: { '$type': 'Link', IdRef: 'tcm:5-100-8', Title: 'Article' },
            LocationInfo: {
                '$type': 'LocationInfo',
                ContextRepository: { '$type': 'Link', IdRef: 'tcm:0-5-1', Title: '050 Content Master' },
                OrganizationalItem: { '$type': 'Link', IdRef: 'tcm:5-10-2', Title: 'Building Blocks' },
            },
            Content: {
                Headline: 'Breaking News',
                Body: 'News body text.',
                PageCount: 5,
                CreatedDate: '2026-04-14T10:00:00Z'
            },
        }),
    });

    // 14. Page: Home Page (Enhanced with Recursive Regions)
    dbPut(456, 64, '10', {
        '10': createBaseItem(456, 64, 'Home Page', '10', {
            FileName: 'index.html',
            LocationInfo: {
                '$type': 'LocationInfo',
                ContextRepository: { '$type': 'Link', IdRef: 'tcm:0-10-1', Title: '100 Website EN' },
                OrganizationalItem: { '$type': 'Link', IdRef: 'tcm:10-20-4', Title: 'Home' },
            },
            PageTemplate: { '$type': 'Link', IdRef: 'tcm:5-99-128', Title: 'Standard Page' },
            ComponentPresentations: [],
            Regions: [
                {
                    '$type': 'EmbeddedRegion',
                    RegionName: 'Main',
                    ComponentPresentations: [
                        {
                            '$type': 'ComponentPresentation',
                            Component: { '$type': 'Link', IdRef: 'tcm:10-123-16', Title: 'About Us' },
                            ComponentTemplate: { '$type': 'Link', IdRef: 'tcm:5-98-32', Title: 'Article CT' }
                        }
                    ],
                    Regions: [
                        {
                            '$type': 'EmbeddedRegion',
                            RegionName: 'Feature',
                            ComponentPresentations: [
                                {
                                    '$type': 'ComponentPresentation',
                                    Component: { '$type': 'Link', IdRef: 'tcm:10-124-16', Title: 'News Item' },
                                    ComponentTemplate: { '$type': 'Link', IdRef: 'tcm:5-98-32', Title: 'Article CT' }
                                }
                            ]
                        }
                    ]
                },
                {
                    '$type': 'EmbeddedRegion',
                    RegionName: 'Sidebar',
                    ComponentPresentations: []
                }
            ],
        }),
    });

    // 15. Category: Regions
    dbPut(200, 512, '1', {
        '1': createBaseItem(200, 512, 'Regions', '1'),
    });

    // 16. Keywords inside Category "Regions"
    dbPut(201, 1024, '1', {
        '1': createBaseItem(201, 1024, 'EMEA', '1', {
            ParentKeywords: [],
            Category: { '$type': 'Link', IdRef: 'tcm:1-200-512', Title: 'Regions' }
        }),
    });
    dbPut(202, 1024, '1', {
        '1': createBaseItem(202, 1024, 'APAC', '1', {
            ParentKeywords: [],
            Category: { '$type': 'Link', IdRef: 'tcm:1-200-512', Title: 'Regions' }
        }),
    });

    // 17. Publications (Type 1) - Support discovery and hierarchy tracing
    publications.forEach(pub => {
        const pubIdNum = pub.Id.match(/tcm:0-(\d+)-1/)?.[1];
        if (pubIdNum) {
            // Seed publications into the primary database map
            dbPut(pubIdNum, 1, '0', {
                '0': {
                    ...pub,
                    '$type': 'Publication',
                    ItemType: 1
                }
            });
        }
    });
};


initDb();

// ============================================================
// --- APPROVAL STATUSES, TARGET TYPES, MULTIMEDIA TYPES, PUB TYPES ---
// ============================================================

const approvalStatuses = [
    { Id: 'tcm:0-1-275', Title: 'Draft', Level: 0 },
    { Id: 'tcm:0-2-275', Title: 'In Review', Level: 50 },
    { Id: 'tcm:0-3-275', Title: 'Approved', Level: 100 },
];

const targetTypes = [
    { Id: 'tcm:0-1-65537', Title: 'Staging', Purpose: 'Staging' },
    { Id: 'tcm:0-2-65537', Title: 'Live', Purpose: 'Live' },
];

const multimediaTypes = [
    { Id: 'tcm:0-1-197', Title: 'JPEG Image', Suffix: '.jpg', MimeType: 'image/jpeg' },
    { Id: 'tcm:0-2-197', Title: 'PNG Image', Suffix: '.png', MimeType: 'image/png' },
    { Id: 'tcm:0-3-197', Title: 'PDF Document', Suffix: '.pdf', MimeType: 'application/pdf' },
    { Id: 'tcm:0-4-197', Title: 'MP4 Video', Suffix: '.mp4', MimeType: 'video/mp4' },
];

const publicationTypes = [
    { Id: 'tcm:0-1-73', Title: 'Web' },
    { Id: 'tcm:0-2-73', Title: 'Content' },
];

const processDefinitions = [
    { Id: 'tcm:0-1-131072', Title: 'Default Workflow' },
];

const users = [
    { Id: 'tcm:0-1-65546', Title: 'Administrator', UserName: 'admin@example.com', IsEnabled: true },
    { Id: 'tcm:0-2-65546', Title: 'Author', UserName: 'author@example.com', IsEnabled: true },
];

// ============================================================
// --- CORE LOGIC ---
// ============================================================

const parseTcmUri = (uri) => {
    // Accepts: tcm:5-123-16, tcm_5_123_16, tcm_5-123-16, tcm:5-123, tcm:0-5-1 (Publication)
    const normalized = uri.replace(/[:_]/g, '-');
    const match = normalized.match(/^tcm-(\d+)-(\d+)(?:-(\d+))?(?:-v(\d+))?$/i);
    if (!match) return null;
    return {
        pubId: match[1],
        itemId: match[2],
        itemType: match[3] || '16', // default to Component if not specified
        version: match[4]
    };
};

/**
 * When a container is a Publication (tcm:0-5-1), the DB uses its own numeric ID ('5') as context.
 * For regular items, the pubId segment is already the context pub.
 */
const resolveContextPubId = (parts) => {
    // Publication items: pubId is '0', itemId is the pub number, itemType is '1'
    if (parts.pubId === '0' && parts.itemType === '1') return parts.itemId;
    return parts.pubId;
};

const toTcmUri = (parts) =>
    `tcm:${parts.pubId}-${parts.itemId}-${parts.itemType}${parts.version ? '-v' + parts.version : ''}`;

const resolveItem = (pubId, itemId, itemType) => {
    // If it's a Publication (Type 1), the context pubId is always '0' in the DB key
    const effectivePubId = itemType === '1' ? '0' : pubId;
    const key = `${itemId}-${itemType}`;
    const record = db.get(key);
    if (!record) return null;

    // Own localization? (For publications, this is the primary record under '0')
    if (record.localizations[effectivePubId]) {
        const item = JSON.parse(JSON.stringify(record.localizations[effectivePubId]));
        
        // Hydrate verbose properties for Schemas (Type 8)
        if (item.ItemType === 8) hydrateSchemaFields(item);

        // Attach current lock state
        const tcmUri = `tcm:${pubId}-${itemId}-${itemType}`;
        const lock = lockState.get(tcmUri);
        if (lock) item.LockInfo = lock;
        return item;
    }

    // Inherited?
    const parents = dbHierarchy[pubId] || [];
    for (const parentId of parents) {
        if (record.localizations[parentId]) {
            const inherited = JSON.parse(JSON.stringify(record.localizations[parentId]));
            inherited.Id = `tcm:${pubId}-${itemId}-${itemType}`;
            inherited.BluePrintInfo = {
                ...inherited.BluePrintInfo,
                IsShared: true,
                IsLocalized: false,
            };
            inherited.LocationInfo = {
                ...inherited.LocationInfo,
                ContextRepository: { IdRef: `tcm:0-${pubId}-1` }
            };

            // Hydrate verbose properties for Schemas (Type 8)
            if (inherited.ItemType === 8) hydrateSchemaFields(inherited);

            return inherited;
        }
    }

    return null;
};

const getAllItemsForContainer = (containerUri, recursive, itemTypeFilter) => {
    const containerParts = parseTcmUri(containerUri);
    if (!containerParts) return [];

    const results = [];

    for (const [key, record] of db.entries()) {
        const [itemId, itemType] = key.split('-');

        // Filter by item type if requested
        if (itemTypeFilter && itemTypeFilter.length > 0) {
            const typeName = ITEM_TYPE_NAME[parseInt(itemType)];
            if (!typeName || !itemTypeFilter.includes(typeName)) continue;
        }

        // Skip publications themselves
        if (itemType === '1') continue;

        // Resolve in the container's publication context
        const item = resolveItem(containerParts.pubId, itemId, itemType);
        if (item) {
            results.push({ Id: item.Id, Title: item.Title, type: item.type });
        }
    }

    return results;
};

const generateId = () => {
    // Generate a unique numeric item ID not already in the db
    let id;
    do {
        id = Math.floor(Math.random() * 50000) + 10000;
    } while (db.has(`${id}-16`) || db.has(`${id}-2`) || db.has(`${id}-64`) || db.has(`${id}-4`));
    return id;
};

// ============================================================
// --- HTTP SERVER ---
// ============================================================

const handleResponse = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
};

const readBody = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { reject(e); }
    });
    req.on('error', reject);
});

const router = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;
    const qs = url.searchParams;

    console.log(`[MOCK] ${method} ${path}`);

    // ── CORS ──────────────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
        // ── 1. AUTH ───────────────────────────────────────────
        if (path === '/access-management/connect/token' && method === 'POST') {
            return handleResponse(res, 200, {
                access_token: `mock-bearer-${crypto.randomBytes(8).toString('hex')}`,
                expires_in: 3600,
                token_type: 'Bearer',
            });
        }

        // ── 2. PUBLICATIONS ───────────────────────────────────
        if (path === '/api/v3.0/publications' && method === 'GET') {
            return handleResponse(res, 200, publications);
        }

        // ── 3. APPROVAL STATUSES ──────────────────────────────
        if (path === '/api/v3.0/approvalStatuses' && method === 'GET') {
            return handleResponse(res, 200, approvalStatuses);
        }

        // ── 4. TARGET TYPES ───────────────────────────────────
        if (path === '/api/v3.0/targetTypes' && method === 'GET') {
            return handleResponse(res, 200, targetTypes);
        }

        // ── 5. MULTIMEDIA TYPES ───────────────────────────────
        if (path === '/api/v3.0/multimediaTypes' && method === 'GET') {
            return handleResponse(res, 200, multimediaTypes);
        }

        // ── 6. PUBLICATION TYPES ──────────────────────────────
        if (path === '/api/v3.0/publicationTypes' && method === 'GET') {
            return handleResponse(res, 200, publicationTypes);
        }

        // ── 7. USERS ──────────────────────────────────────────
        if (path === '/api/v3.0/users' && method === 'GET') {
            return handleResponse(res, 200, users);
        }

        if (path.match(/^\/api\/v3\.0\/users\/[^/]+$/) && method === 'GET') {
            const userId = path.split('/').pop().replace(/_/g, ':');
            const user = users.find(u => u.Id === userId) || users[0];
            return handleResponse(res, 200, user);
        }

        // ── 7a. ACTIVITY INSTANCES ────────────────────────────
        if (path === '/api/v3.0/activityInstances' && method === 'GET') {
            const statusFilter = qs.getAll('activityStates').flatMap(v => v.split(','));
            let results = Array.from(activityInstances.values());
            if (statusFilter.length > 0) {
                results = results.filter(a => statusFilter.includes(a.ActivityInstanceStatus));
            }
            return handleResponse(res, 200, results);
        }

        // ── 8. SEARCH ─────────────────────────────────────────
        if (path === '/api/v3.0/system/search' && method === 'POST') {
            const body = await readBody(req);
            const query = Array.isArray(body) ? (body[0] || {}) : body;

            const searchTitle = query.Title?.toLowerCase();
            const filterTypes = query.ItemTypes; // e.g. ['Component']
            const searchInUri = query.SearchIn;
            const schemaFilter = query.BasedOnSchemas; // [{ schemaUri, fieldFilter }]
            const authorFilter = query.Author;

            const results = [];
            for (const [key, record] of db.entries()) {
                const [id, typeNum] = key.split('-');
                const typeName = ITEM_TYPE_NAME[parseInt(typeNum)];
                if (!typeName) continue;

                const item = record.localizations[record.owningPub];
                if (!item) continue;

                // Type filter
                if (filterTypes && filterTypes.length > 0 && !filterTypes.includes(typeName)) continue;

                // Title filter
                if (searchTitle && !item.Title.toLowerCase().includes(searchTitle)) continue;

                // Schema filter
                if (schemaFilter && schemaFilter.length > 0) {
                    const schemaIdRef = item.Schema?.IdRef;
                    const schemaMatch = schemaFilter.some(sf => sf.schemaUri === schemaIdRef);
                    if (!schemaMatch) continue;
                }

                // Author filter
                if (authorFilter && item.VersionInfo?.CheckOutUser?.IdRef !== authorFilter) continue;

                results.push({ Id: item.Id, Title: item.Title, type: typeName });
            }

            return handleResponse(res, 200, results);
        }

        // ── 9. BULK READ ──────────────────────────────────────
        if (path === '/api/v3.0/items/bulkRead' && method === 'POST') {
            const itemIds = await readBody(req);

            const result = {};
            for (const uri of itemIds) {
                const parts = parseTcmUri(uri);
                if (!parts) continue;
                const item = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                if (item) result[uri] = item;
            }
            return handleResponse(res, 200, result);
        }

        // ── 10. PUBLISH ───────────────────────────────────────
        if (path === '/api/v3.0/items/publish' && method === 'POST') {
            const body = await readBody(req);
            const itemIds = body.Ids || [];
            const targets = body.TargetIdsOrPurposes || [];
            const txIds = [];

            for (const itemUri of itemIds) {
                for (const target of targets) {
                    const txId = `tcm:0-${generateId()}-96`;
                    const targetObj = targetTypes.find(t => t.Id === target || t.Purpose === target) || { Id: target, Title: target };
                    txIds.push(txId);
                    publishTransactions.set(txId, {
                        Id: txId,
                        State: 'Success',
                        Priority: body.Priority || 'Normal',
                        PublishedAt: now(),
                        Item: { IdRef: itemUri },
                        TargetType: targetObj,
                    });

                    // Update publish state
                    if (!publishState.has(itemUri)) publishState.set(itemUri, []);
                    const existing = publishState.get(itemUri).filter(e => e.TargetType.Id !== targetObj.Id);
                    existing.push({ TargetType: targetObj, PublishedAt: now(), TransactionId: txId });
                    publishState.set(itemUri, existing);
                }
            }
            return handleResponse(res, 202, { PublishTransactionIds: txIds });
        }

        // ── 11. UNPUBLISH ─────────────────────────────────────
        if (path === '/api/v3.0/items/unPublish' && method === 'POST') {
            const body = await readBody(req);
            const itemIds = body.Ids || [];
            const targets = body.TargetIdsOrPurposes || [];

            for (const itemUri of itemIds) {
                if (!publishState.has(itemUri)) continue;
                for (const target of targets) {
                    const targetObj = targetTypes.find(t => t.Id === target || t.Purpose === target);
                    if (!targetObj) continue;
                    publishState.set(itemUri, publishState.get(itemUri).filter(e => e.TargetType.Id !== targetObj.Id));
                }
            }
            return handleResponse(res, 202, { PublishTransactionIds: [] });
        }

        // ── 12. ITEMS TO PUBLISH (dry run) ────────────────────
        if (path === '/api/v3.0/items/itemsToPublish' && method === 'POST') {
            const body = await readBody(req);
            const itemIds = body.Ids || [];
            const targets = body.TargetIdsOrPurposes || [];

            const preview = [];
            for (const itemUri of itemIds) {
                const parts = parseTcmUri(itemUri);
                if (!parts) continue;
                const item = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                if (!item) continue;

                for (const target of targets) {
                    const targetObj = targetTypes.find(t => t.Id === target || t.Purpose === target) || { Id: target, Title: target };
                    const pub = publications.find(p => p.Id === `tcm:0-${parts.pubId}-1`);
                    preview.push({
                        Item: { IdRef: itemUri, Title: item.Title },
                        Publication: { IdRef: `tcm:0-${parts.pubId}-1`, Title: pub?.Title || `Pub ${parts.pubId}` },
                        TargetType: targetObj,
                    });
                }
            }
            return handleResponse(res, 200, preview);
        }

        // ── 13. PUBLISH TRANSACTIONS ──────────────────────────
        if (path === '/api/v3.0/items/publishTransactions' && method === 'GET') {
            return handleResponse(res, 200, [...publishTransactions.values()]);
        }

        // ── 14. LOCKED ITEMS ──────────────────────────────────
        if (path === '/api/v3.0/items/lockedItems' && method === 'GET') {
            const locked = [];
            for (const [uri, lock] of lockState.entries()) {
                if (lock.LockType !== 'None') {
                    locked.push({ Id: uri, LockInfo: lock });
                }
            }
            return handleResponse(res, 200, locked);
        }

        // ── 15. CREATE ITEM (generic: Folder, SG, Category, etc) ──
        if (path === '/api/v3.0/items' && method === 'POST') {
            const input = await readBody(req);
            const parentUri =
                input.LocationInfo?.OrganizationalItem?.IdRef ||
                input.LocationInfo?.StructureGroup?.IdRef ||
                input.locationId;

            const parentParts = parseTcmUri(parentUri);
            if (!parentParts) return handleResponse(res, 400, { Message: 'Invalid Location ID' });

            const typeMap = {
                Folder: 2, StructureGroup: 4, Category: 512, Keyword: 1024,
                Bundle: 8192, Schema: 8,
            };
            const itemTypeStr = input['$type']?.replace(/Request$/, '') || input.itemType || 'Folder';
            const typeNum = typeMap[itemTypeStr] || 2;
            const newItemId = generateId();

            const contextPubId = resolveContextPubId(parentParts);
            const extra = { ...input };
            delete extra.Title;
            delete extra['$type'];
            delete extra.locationId;
            delete extra.itemType;

            const newItem = createBaseItem(newItemId, typeNum, input.Title, contextPubId, extra);
            dbPut(newItemId, typeNum, contextPubId, { [contextPubId]: newItem });
            return handleResponse(res, 201, newItem);
        }

        // ── 16. ITEM-LEVEL ROUTES ("/api/v3.0/items/{id}/...") ──
        const itemPathMatch = path.match(/^\/api\/v3\.0\/items\/([^/]+)(\/.*)?$/);
        if (itemPathMatch) {
            const rawId = itemPathMatch[1];
            const subPath = itemPathMatch[2] || '';
            const parts = parseTcmUri(rawId);

            if (!parts) return handleResponse(res, 400, { Message: `Invalid TCM URI: ${rawId}` });
            const tcmUri = toTcmUri(parts);

            // ── 16a. ITEMS IN CONTAINER ───────────────────────
            if (subPath === '/items' && method === 'GET') {
                const recursive = qs.get('recursive') === 'true';
                const typeFilter = qs.getAll('rloItemTypes').flatMap(v => v.split(','));
                const contextPubId = resolveContextPubId(parts);
                const effectiveUri = `tcm:${contextPubId}-${parts.itemId}-${parts.itemType}`;
                const items = getAllItemsForContainer(effectiveUri, recursive, typeFilter.length ? typeFilter : null);
                return handleResponse(res, 200, items);
            }

            // ── 16b. CATEGORIES ───────────────────────────────
            if (subPath === '/categories' && method === 'GET') {
                // Return all categories in the given publication context
                const contextPubId = resolveContextPubId(parts);
                const cats = [];
                for (const [key, record] of db.entries()) {
                    const [id, typeNum] = key.split('-');
                    if (typeNum !== '512') continue;
                    const item = resolveItem(contextPubId, id, typeNum);
                    if (item) cats.push({ Id: item.Id, Title: item.Title, type: 'Category' });
                }
                return handleResponse(res, 200, cats);
            }

            // ── 16c. KEYWORDS IN CATEGORY ─────────────────────
            if (subPath === '/keywords' && method === 'GET') {
                const contextPubId = resolveContextPubId(parts);
                const catUri = `tcm:${contextPubId}-${parts.itemId}-${parts.itemType}`;
                const keywords = [];
                for (const [key, record] of db.entries()) {
                    const [id, typeNum] = key.split('-');
                    if (typeNum !== '1024') continue;
                    const item = resolveItem(contextPubId, id, typeNum);
                    if (item && item.Category?.IdRef === catUri) {
                        keywords.push({ Id: item.Id, Title: item.Title, type: 'Keyword' });
                    }
                }
                return handleResponse(res, 200, keywords);
            }

            // ── 16d. SCHEMA LINKS ─────────────────────────────
            if (subPath === '/schemaLinks' && method === 'GET') {
                const purposes = qs.getAll('schemaPurpose').flatMap(v => v.split(','));
                const contextPubId = resolveContextPubId(parts);
                const links = [];
                for (const [key, record] of db.entries()) {
                    const [id, typeNum] = key.split('-');
                    if (typeNum !== '8') continue; // Schemas only
                    const item = resolveItem(contextPubId, id, typeNum);
                    if (!item) continue;
                    if (purposes.length > 0 && item.Purpose && !purposes.includes(item.Purpose)) continue;
                    links.push({ IdRef: item.Id, Title: item.Title });
                }
                return handleResponse(res, 200, links);
            }

            // ── 16e. BLUEPRINT HIERARCHY ──────────────────────
            if (subPath === '/bluePrintHierarchy' && method === 'GET') {
                const nodes = [];
                const isPublicationRequest = parts.pubId === '0' && parts.itemType === '1';

                for (const pub of publications) {
                    const pubIdNum = pub.Id.match(/tcm:0-(\d+)-1/)?.[1];
                    if (!pubIdNum) continue;

                    let nodeItem;
                    if (isPublicationRequest) {
                        // Publication structure requests: the Item for each node IS the publication itself.
                        // The real API returns Publication objects so the tool's filter can see
                        // non-null items and build the ancestor/child graph correctly.
                        nodeItem = {
                            Id: pub.Id,
                            Title: pub.Title,
                            '': 'Publication',
                            BluePrintInfo: {
                                IsShared: false,
                                IsLocalized: false,
                                OwningRepository: { IdRef: pub.Id }
                            }
                        };
                    } else {
                        // Content item requests: resolve the item in each publication context.
                        nodeItem = resolveItem(pubIdNum, parts.itemId, parts.itemType) || null;
                    }

                    // Each node carries its publication-level parents for graph traversal.
                    const parents = (pub.Parents || []).map(p => ({ IdRef: p.IdRef }));

                    nodes.push({
                        ContextRepositoryId: pub.Id,
                        ContextRepositoryTitle: pub.Title,
                        Parents: parents,
                        Item: nodeItem,
                    });
                }

                return handleResponse(res, 200, { Items: nodes });
            }

            // ── 16f. ITEM HISTORY ─────────────────────────────
            if (subPath === '/history' && method === 'GET') {
                const item = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                if (!item) return handleResponse(res, 404, { Message: `Item ${tcmUri} not found` });

                const versions = [];
                // Return actual current version and simulated history
                for (let v = item.VersionInfo.Version; v >= 1; v--) {
                    versions.push({
                        Id: `${tcmUri}-v${v}`,
                        Version: v,
                        Revision: 0,
                        CreationDate: item.VersionInfo.CreationDate,
                        RevisionDate: item.VersionInfo.RevisionDate,
                        Creator: item.VersionInfo.Creator || { IdRef: 'tcm:0-1-65546', Title: 'Administrator' },
                        Owner: item.VersionInfo.Owner || { IdRef: 'tcm:0-1-65546', Title: 'Administrator' }
                    });
                }
                return handleResponse(res, 200, versions);
            }


            // ── 16g. PUBLISH INFO ─────────────────────────────
            if (subPath === '/publishedItems' && method === 'GET') {
                const pubInfo = publishState.get(tcmUri) || [];
                return handleResponse(res, 200, pubInfo);
            }

            // ── 16h. DEPENDENCY GRAPH (simplified) ────────────
            if (subPath === '/dependencyGraph' && method === 'GET') {
                const item = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                if (!item) return handleResponse(res, 404, { Message: `Item ${tcmUri} not found` });

                // For pages, return their component presentations as dependencies
                const deps = [];
                if (item.ComponentPresentations) {
                    for (const cp of item.ComponentPresentations) {
                        const cpParts = parseTcmUri(cp.Component.IdRef);
                        const cpItem = cpParts ? resolveItem(cpParts.pubId, cpParts.itemId, cpParts.itemType) : null;
                        if (cpItem) {
                            deps.push({
                                Item: { Id: cpItem.Id, Title: cpItem.Title, type: cpItem.type },
                                Dependencies: [],
                            });
                        }
                    }
                }
                return handleResponse(res, 200, { Item: { Id: item.Id, Title: item.Title }, Dependencies: deps });
            }

            // ── 16i. USED-BY HISTORY ──────────────────────────
            if (subPath === '/usedByHistory' && method === 'GET') {
                return handleResponse(res, 200, []);
            }

            // ── 16j. CHECKOUT ─────────────────────────────────
            if (subPath === '/checkOut' && method === 'POST') {
                const item = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                if (!item) return handleResponse(res, 404, { Message: `Item ${tcmUri} not found` });
                if (item.BluePrintInfo?.IsShared) return handleResponse(res, 403, { Message: 'Cannot check out a shared item. Localize it first.' });

                lockState.set(tcmUri, {
                    LockType: 'CheckedOut',
                    LockUser: { Title: 'Administrator', Id: users[0].Id },
                });

                const updatedItem = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                return handleResponse(res, 200, updatedItem);
            }

            // ── 16k. CHECKIN ──────────────────────────────────
            if (subPath === '/checkIn' && method === 'POST') {
                const item = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                if (!item) return handleResponse(res, 404, { Message: `Item ${tcmUri} not found` });
                lockState.delete(tcmUri);

                const key = `${parts.itemId}-${parts.itemType}`;
                const record = db.get(key);
                if (record?.localizations[parts.pubId]) {
                    record.localizations[parts.pubId].VersionInfo.Version += 1;
                    record.localizations[parts.pubId].VersionInfo.RevisionDate = now();
                }
                return handleResponse(res, 200, resolveItem(parts.pubId, parts.itemId, parts.itemType));
            }

            // ── 16l. UNDO CHECKOUT ────────────────────────────
            if (subPath === '/undoCheckOut' && method === 'POST') {
                lockState.delete(tcmUri);
                const item = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                if (!item) return handleResponse(res, 404, { Message: `Item ${tcmUri} not found` });
                return handleResponse(res, 200, item);
            }

            // ── 16m. LOCALIZE ─────────────────────────────────
            if (subPath === '/localize' && method === 'POST') {
                const item = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                if (!item) return handleResponse(res, 404, { Message: 'Item not found' });
                if (!item.BluePrintInfo.IsShared) return handleResponse(res, 409, { Message: 'Item is already local' });

                const key = `${parts.itemId}-${parts.itemType}`;
                const record = db.get(key);
                const masterItem = record.localizations[record.owningPub];

                const clone = JSON.parse(JSON.stringify(masterItem));
                clone.Id = tcmUri;
                clone.BluePrintInfo = {
                    ...clone.BluePrintInfo,
                    IsLocalized: true,
                    IsShared: false,
                    OwningRepository: { IdRef: `tcm:0-${parts.pubId}-1` }
                };
                clone.LocationInfo = {
                    ...clone.LocationInfo,
                    ContextRepository: { IdRef: `tcm:0-${parts.pubId}-1` }
                };
                record.localizations[parts.pubId] = clone;
                return handleResponse(res, 201, { Message: 'Item localized', Id: tcmUri });
            }

            // ── 16n. UNLOCALIZE ───────────────────────────────
            if (subPath === '/unlocalize' && method === 'POST') {
                const key = `${parts.itemId}-${parts.itemType}`;
                const record = db.get(key);
                if (!record || !record.localizations[parts.pubId]) return handleResponse(res, 404, { Message: 'Local item not found' });
                if (record.owningPub === parts.pubId) return handleResponse(res, 403, { Message: 'Cannot unlocalize the primary item' });
                delete record.localizations[parts.pubId];
                return handleResponse(res, 200, { Message: 'Item unlocalized' });
            }

            // ── 16o. PROMOTE ──────────────────────────────────
            if (subPath === '/promote' && method === 'POST') {
                const body = await readBody(req);
                const destPubId = parseTcmUri(body.DestinationRepositoryId)?.pubId;
                if (!destPubId) return handleResponse(res, 400, { Message: 'Invalid DestinationRepositoryId' });

                const key = `${parts.itemId}-${parts.itemType}`;
                const record = db.get(key);
                const item = record?.localizations[parts.pubId];
                if (!item) return handleResponse(res, 404, { Message: 'Item not found in source publication' });

                const promoted = JSON.parse(JSON.stringify(item));
                promoted.Id = `tcm:${destPubId}-${parts.itemId}-${parts.itemType}`;
                promoted.BluePrintInfo.OwningRepository = { IdRef: `tcm:0-${destPubId}-1` };
                promoted.BluePrintInfo.IsShared = false;
                promoted.BluePrintInfo.IsLocalized = false;
                promoted.LocationInfo.ContextRepository = { IdRef: `tcm:0-${destPubId}-1` };
                record.localizations[destPubId] = promoted;
                record.owningPub = destPubId;
                return handleResponse(res, 200, { Message: 'Item promoted', Id: promoted.Id });
            }

            // ── 16p. CLASSIFY ─────────────────────────────────
            if (subPath === '/classify' && method === 'POST') {
                const body = await readBody(req);
                if (!classificationState.has(tcmUri)) classificationState.set(tcmUri, new Set());
                const current = classificationState.get(tcmUri);
                for (const kw of (body.AddKeywords || [])) current.add(kw.IdRef || kw);
                for (const kw of (body.RemoveKeywords || [])) current.delete(kw.IdRef || kw);
                return handleResponse(res, 200, { Message: 'Classified', Keywords: [...current] });
            }

            // ── 16q. ITEMS CLASSIFIED BY KEYWORD (on keyword) ─
            if (subPath === '/usedByItems' && method === 'GET') {
                const results = [];
                for (const [uri, keywords] of classificationState.entries()) {
                    if (keywords.has(tcmUri)) results.push({ Id: uri });
                }
                return handleResponse(res, 200, results);
            }

            // ── 16r. PROCESS DEFINITIONS (on publication) ─────
            if (subPath === '/processDefinitions' && method === 'GET') {
                return handleResponse(res, 200, processDefinitions);
            }

            // ── 16s. COMPONENT TEMPLATE LINKS (on schema) ─────
            if (subPath === '/componentTemplateLinks' && method === 'GET') {
                const templates = [];
                for (const [key, record] of db.entries()) {
                    const [id, typeNum] = key.split('-');
                    if (typeNum !== '32') continue;
                    const item = resolveItem(parts.pubId, id, typeNum);
                    if (item) templates.push({ Id: item.Id, Title: item.Title, type: 'ComponentTemplate' });
                }
                return handleResponse(res, 200, templates);
            }

            // ── 16t. GET SINGLE ITEM ──────────────────────────
            if (method === 'GET') {
                const item = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                if (!item) return handleResponse(res, 404, { Message: `Item ${tcmUri} not found` });
                return handleResponse(res, 200, item);
            }

            // ── 16u. CREATE COMPONENT / PAGE ─────────────────
            if (method === 'POST' && subPath === '') {
                // Handled above in generic create
                return handleResponse(res, 405, { Message: 'Method Not Allowed on this sub-path' });
            }

            // ── 16v. UPDATE ITEM (PUT) ────────────────
            if (method === 'PUT') {
                const update = await readBody(req);
                const key = `${parts.itemId}-${parts.itemType}`;
                const record = db.get(key);
                if (!record) return handleResponse(res, 404, { Message: 'Item not found in DB' });

                // ── BLUEPRINT SAFETY ──────────────────────
                const item = resolveItem(parts.pubId, parts.itemId, parts.itemType);
                if (!item) return handleResponse(res, 404, { Message: 'Item not found in Blueprint' });
                
                if (item.BluePrintInfo.IsShared) {
                    return handleResponse(res, 403, { 
                        Message: `Cannot update inherited item ${tcmUri}. Localize it first.` 
                    });
                }

                // ── LOCK & VERSION LOGIC ──────────────────
                const currentLock = lockState.get(tcmUri);
                const isLockedToOther = currentLock && currentLock.LockType !== 'None' && currentLock.LockUser?.IdRef !== 'tcm:0-1-65546';
                
                if (isLockedToOther) {
                    return handleResponse(res, 403, { Message: `Item is locked by ${currentLock.LockUser.Title}` });
                }

                // Simulate Auto-Checkout/In behaviour
                const targetPub = record.localizations[parts.pubId];
                if (targetPub) {
                    if (!currentLock || currentLock.LockType === 'None') {
                        // Not checked out: Increment major version
                        targetPub.VersionInfo.Version += 1;
                        targetPub.VersionInfo.Revision = 0;
                    } else {
                        // Checked out to us: Increment revision
                        targetPub.VersionInfo.Revision += 1;
                    }
                    
                    // Deep merge Content and Metadata, shallow merge everything else
                    if (update.Content) targetPub.Content = { ...(targetPub.Content || {}), ...update.Content };
                    if (update.Metadata) targetPub.Metadata = { ...(targetPub.Metadata || {}), ...update.Metadata };
                    if (update.Title) targetPub.Title = update.Title;
                    if (update.FileName) targetPub.FileName = update.FileName;
                    if (update.ComponentPresentations) targetPub.ComponentPresentations = update.ComponentPresentations;
                    if (update.Regions) targetPub.Regions = update.Regions;

                    targetPub.VersionInfo.RevisionDate = now();
                    return handleResponse(res, 200, targetPub);
                }
                
                return handleResponse(res, 500, { Message: 'Unexpected localization state' });
            }

            // ── 16w. FINISH ACTIVITY ──────────────────────────
            if (subPath === '/finish' && method === 'POST') {
                const activity = activityInstances.get(tcmUri);
                if (!activity) return handleResponse(res, 404, { Message: 'Activity instance not found' });
                
                activity.ActivityInstanceStatus = 'Finished';
                activity.FinishDate = now();
                return handleResponse(res, 200, activity);
            }


            // ── 16w. DELETE ───────────────────────────────────
            if (method === 'DELETE') {
                const key = `${parts.itemId}-${parts.itemType}`;
                const record = db.get(key);
                if (!record || !record.localizations[parts.pubId]) {
                    return handleResponse(res, 404, { Message: 'Item not found in this publication' });
                }

                delete record.localizations[parts.pubId];
                lockState.delete(tcmUri);
                if (Object.keys(record.localizations).length === 0) db.delete(key);
                return handleResponse(res, 204, {});
            }
        }

        // ── 17. COMPONENT CREATE ──────────────────────────────
        // (Separate endpoint: POST /api/v3.0/items with $type = ComponentData)
        // Handled under generic create above. Logged for clarity.

        // ── 18. PUBLISH TRANSACTIONS (alias) ─────────────────
        if (path === '/api/v3.0/publishTransactions' && method === 'GET') {
            return handleResponse(res, 200, [...publishTransactions.values()]);
        }

        // ── FALLBACK ──────────────────────────────────────────
        return handleResponse(res, 404, { Message: `Not Found: ${method} ${path}` });

    } catch (e) {
        console.error('[MOCK ERROR]', e.message);
        return handleResponse(res, 500, { Message: 'Internal Mock Server Error', Detail: e.message });
    }
};

// ============================================================
// --- START SERVER ---
// ============================================================

const server = http.createServer(router);

server.listen(PORT, () => {
    console.log(`\n${'='.repeat(55)}`);
    console.log(`  Tridion Sites Mock Server v2 – http://localhost:${PORT}`);
    console.log(`${'='.repeat(55)}\n`);
    console.log('Publications:');
    publications.forEach(p => console.log(`  ${p.Id}  ${p.Title}`));
    console.log('\nEndpoints supported:');
    [
        'POST /access-management/connect/token  -> Auth',
        'GET  /api/v3.0/publications            -> getPublications',
        'GET  /api/v3.0/approvalStatuses        -> getApprovalStatuses',
        'GET  /api/v3.0/targetTypes             -> getTargetTypes',
        'GET  /api/v3.0/multimediaTypes         -> getMultimediaTypes',
        'GET  /api/v3.0/publicationTypes        -> getPublicationTypes',
        'GET  /api/v3.0/users                   -> getUsers',
        'POST /api/v3.0/system/search           -> search',
        'POST /api/v3.0/items/bulkRead          -> bulkReadItems',
        'POST /api/v3.0/items/publish           -> publish',
        'POST /api/v3.0/items/unPublish         -> unpublish',
        'POST /api/v3.0/items/itemsToPublish    -> publish (dryRun)',
        'GET  /api/v3.0/items/lockedItems       -> getLockedItems',
        'GET  /api/v3.0/items/{id}              -> getItem',
        'POST /api/v3.0/items/{id}/checkOut     -> checkOutItem',
        'POST /api/v3.0/items/{id}/checkIn      -> checkInItem',
        'POST /api/v3.0/items/{id}/undoCheckOut -> undoCheckOutItem',
        'POST /api/v3.0/items/{id}/localize     -> localizeItem',
        'POST /api/v3.0/items/{id}/unlocalize   -> unlocalizeItem',
        'POST /api/v3.0/items/{id}/promote      -> promoteItem',
        'POST /api/v3.0/items/{id}/classify     -> classify',
        'GET  /api/v3.0/items/{id}/items        -> getItemsInContainer',
        'GET  /api/v3.0/items/{id}/categories   -> getCategories',
        'GET  /api/v3.0/items/{id}/keywords     -> getClassificationKeywordsForCategory',
        'GET  /api/v3.0/items/{id}/schemaLinks  -> getSchemaLinks',
        'GET  /api/v3.0/items/{id}/history      -> getItemHistory',
        'GET  /api/v3.0/items/{id}/publishedItems -> getPublishInfo',
        'GET  /api/v3.0/items/{id}/dependencyGraph -> getDependencyGraph',
        'GET  /api/v3.0/items/{id}/bluePrintHierarchy -> getRelatedBluePrintItems',
        'PATCH /api/v3.0/items/{id}             -> updateContent / updateMetadata / updateItemProperties',
        'DELETE /api/v3.0/items/{id}            -> deleteItem',
        'POST /api/v3.0/items                   -> createItem / createComponent / createPage',
    ].forEach(line => console.log(`  ${line}`));
    console.log('\nPress Ctrl+C to stop.\n');
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`[MOCK] Port ${PORT} is already in use. Kill the existing process first.`);
        process.exit(1);
    }
    throw e;
});
