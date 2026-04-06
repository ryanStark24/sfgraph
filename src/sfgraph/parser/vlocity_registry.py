"""Canonical Vlocity/OmniStudio DataPack type registry.

Seeded from the upstream `vlocity_build` supported type inventory so we can
recognize the broad DataPack surface area even before every type has a rich,
specialized parser implementation.
"""
from __future__ import annotations

SUPPORTED_VLOCITY_DATAPACK_TYPES: tuple[str, ...] = (
    "Attachment",
    "AttributeAssignmentRule",
    "AttributeCategory",
    "CalculationMatrix",
    "CalculationProcedure",
    "Catalog",
    "ContextAction",
    "ContextDimension",
    "ContextScope",
    "ContractType",
    "CpqConfigurationSetup",
    "DataRaptor",
    "Document",
    "DocumentClause",
    "DocumentTemplate",
    "EntityFilter",
    "IntegrationProcedure",
    "IntegrationRetryPolicy",
    "InterfaceImplementation",
    "ItemImplementation",
    "ManualQueue",
    "ObjectClass",
    "ObjectContextRule",
    "ObjectLayout",
    "OmniScript",
    "OfferMigrationPlan",
    "OrchestrationDependencyDefinition",
    "OrchestrationItemDefinition",
    "OrchestrationPlanDefinition",
    "Pricebook2",
    "PriceList",
    "PricingPlan",
    "PricingVariable",
    "Product2",
    "Promotion",
    "QueryBuilder",
    "Rule",
    "StoryObjectConfiguration",
    "String",
    "System",
    "TimePlan",
    "TimePolicy",
    "UIFacet",
    "UISection",
    "VlocityAction",
    "VlocityAttachment",
    "VlocityCard",
    "VlocityFunction",
    "VlocityPicklist",
    "VlocitySearchWidgetSetup",
    "VlocityStateModel",
    "VlocityUILayout",
    "VlocityUITemplate",
    "VqMachine",
    "VqResource",
)

SUPPORTED_VLOCITY_DATAPACK_TYPE_SET: frozenset[str] = frozenset(
    SUPPORTED_VLOCITY_DATAPACK_TYPES
)
SUPPORTED_VLOCITY_DATAPACK_TYPE_HINTS: tuple[str, ...] = tuple(
    sorted((value.lower() for value in SUPPORTED_VLOCITY_DATAPACK_TYPES), key=len, reverse=True)
)
