import { z } from "zod";
import { createAuthenticatedAxios } from "../utils/axios.js";
import { toLink } from "../utils/links.js";
import { handleAxiosError, handleUnexpectedResponse } from "../utils/errorUtils.js";
import { fieldDefinitionSchema } from "../schemas/fieldValueSchema.js";
import { convertLinksRecursively, processAndOrderFieldDefinitions, formatForApi, formatForAgent } from "../utils/fieldReordering.js";
import { regionDefinitionSchema } from "../schemas/regionDefinitionSchemas.js";
import { diagnoseBluePrintError } from "../utils/bluePrintDiagnostics.js";
import { getCachedDefaultModel } from "../utils/defaultModelCache.js";

export const createRegionSchema = {
    name: "createRegionSchema",
    summary: "Creates a Schema for Page Regions to define layout structures, region constraints, and optional metadata. Regions serve as containers for Component Presentations and nested regions, allowing you to enforce specific slot constraints and Page organization.",
    description: `Creates a new Content Manager System (CMS) item of type 'Schema' with a purpose of 'Region'.

BluePrint Inheritance Note:
The Schema will be created in the specified Folder and be automatically inherited by all descendant Publications.

Region Schemas are used by Page Templates to define the layout and content areas (regions) of a Page. This tool is the correct choice for creating the "Page Schema" that a Page Template links to.

A Region Schema can define:
1. Constraints on the Component Presentations that can be placed within it (using "type": "Link").
2. A set of nested Regions, each linking to its own Region Schema (using "type": "ExpandableLink").
3. A set of metadata fields for the Region itself.

This tool accepts the 'regionDefinition' as a direct JSON object, making it much easier to define constraints and nested regions.

IMPORTANT
When defining a 'TypeConstraint', the 'BasedOnSchema' and 'BasedOnComponentTemplate' properties must be a Link: { "type": "Link", "IdRef": "tcm:1-2-8" }
When defining a 'NestedRegion', the 'RegionSchema' property must be an ExpandableLink that references a valid, existing Region Schema: { "type": "ExpandableLink", "IdRef": "tcm:1-3-8" }

Note on Nested Region Workflow: A NestedRegion's RegionSchema property must link to a valid schema ID; placeholders like "tcm:0-0-0" are not allowed and will cause a validation error.
You must first create the schemas for your nested regions, then create the main Page Schema that links to them.
Best Practice (Flexible): Create a separate Region Schema for each nested region (e.g., "Main Region", "Sidebar Region"). This allows you to define different ComponentPresentationConstraints for each.
Simple Pattern (Shared): Create one generic Region Schema and have all NestedRegions link to it. This is faster, but all regions will share the same constraints.

Simple Pattern (Shared): Create one generic Region Schema and have all NestedRegions link to it. This is faster, but all regions will share the same constraints.`,
    input: {
        title: z.string().nonempty().describe("The title for the new Region Schema."),
        locationId: z.string().regex(/^tcm:\d+-\d+-2$/).describe("The TCM URI of the parent Folder where the new Schema will be created."),
        description: z.string().nonempty().describe("A mandatory description of the Schema."),
        metadataFields: z.array(fieldDefinitionSchema).optional().describe("An array of metadata field definitions for the Region Schema itself. The order of the array determines the field order."),
        regionDefinition: regionDefinitionSchema.optional().describe("A JSON object defining the Region's constraints, nested regions, and localizability."),
        isIndexable: z.boolean().optional().describe("Specifies whether metadata values are indexed for searching."),
        isPublishable: z.boolean().optional().describe("Specifies whether metadata values are published.")
    },
    execute: async (args: any, context: any) => {
        formatForApi(args);
        const req = context?.request;
        const cookieHeader = req?.headers?.cookie || '';
        const match = cookieHeader.match(/UserSessionID=([^;]+)/);
        const userSessionId = match ? match[1] : null;

        const {
            title, locationId, description, metadataFields, regionDefinition,
            isIndexable, isPublishable
        } = args;

        const authenticatedAxios = createAuthenticatedAxios(userSessionId);

        try {
            const processedMetadataFields = metadataFields ? await processAndOrderFieldDefinitions(metadataFields, locationId, authenticatedAxios) : undefined;

            if (processedMetadataFields) {
                convertLinksRecursively(processedMetadataFields, locationId);
            }

            if (regionDefinition) {
                convertLinksRecursively(regionDefinition, locationId);
            }

            let payload;
            try {
                payload = await getCachedDefaultModel("Schema", locationId, authenticatedAxios);
            } catch (error: any) {
                return handleAxiosError(error, "Failed to load default model for Schema");
            }

            payload.Title = title;
            payload.Purpose = "Region";
            delete payload.RootElementName;

            if (description) payload.Description = description;
            if (processedMetadataFields) payload.MetadataFields = processedMetadataFields;
            if (regionDefinition) payload.RegionDefinition = regionDefinition;
            if (typeof isIndexable === 'boolean') payload.IsIndexable = isIndexable;
            if (typeof isPublishable === 'boolean') payload.IsPublishable = isPublishable;

            if (!payload.LocationInfo?.OrganizationalItem?.IdRef) {
                payload.LocationInfo = { ...payload.LocationInfo, OrganizationalItem: toLink(locationId) };
            }

            const createResponse = await authenticatedAxios.post('/items', payload);
            if (createResponse.status === 201) {
                const responseData = {
                    $type: createResponse.data['$type'],
                    Id: createResponse.data.Id,
                    Message: `Successfully created ${createResponse.data.Id}`
                };
                const formattedResponseData = formatForAgent(responseData);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify(formattedResponseData, null, 2)
                    }],
                };
            } else {
                return handleUnexpectedResponse(createResponse);
            }
        } catch (error) {
            await diagnoseBluePrintError(error, args, locationId, authenticatedAxios);
            return handleAxiosError(error, "Failed to create Region Schema");
        }
    },
    examples: [
        {
            description: "Create a Region Schema with constraints on its Component Presentations.",
            payload: `const result = await tools.createRegionSchema({
    title: "Constrained Region Schema",
    locationId: "tcm:5-2-2",
    description: "A Region that constrains what can be put inside it.",
    regionDefinition: {
        "type": "RegionDefinition",
        "ComponentPresentationConstraints": [
            {
                "type": "OccurrenceConstraint",
                "MaxOccurs": 5,
                "MinOccurs": 0
            },
            {
                "type": "TypeConstraint",
                "BasedOnSchema": { "type": "Link", "IdRef": "tcm:5-103-8" },
                "BasedOnComponentTemplate": { "type": "Link", "IdRef": "tcm:5-105-32" }
            }
        ]
    }
});`
        },
        {
            description: "Create an advanced Region Schema with a nested region. Note the use of \\\"type\\\": \\\"ExpandableLink\\\" for the 'RegionSchema' property inside 'NestedRegions'.",
            payload: `const result = await tools.createRegionSchema({
    title: "News Page Region",
    locationId: "tcm:2-18-2",
    description: "Region Schema for a News Page, including a nested region for the main article.",
    regionDefinition: {
        "type": "RegionDefinition",
        "ComponentPresentationConstraints": [
            {
                "type": "OccurrenceConstraint",
                "MaxOccurs": 3,
                "MinOccurs": 0
            },
            {
                "type": "TypeConstraint",
                "BasedOnComponentTemplate": { "type": "Link", "IdRef": "tcm:2-105-32" },
                "BasedOnSchema": { "type": "Link", "IdRef": "tcm:2-104-8" }
            }
        ],
        "NestedRegions": [
            {
                "type": "NestedRegion",
                "RegionName": "Article",
                "IsMandatory": true,
                "RegionSchema": {
                    "type": "ExpandableLink",
                    "IdRef": "tcm:2-181-8"
                }
            }
        ]
    }
});`
        }
    ]
};