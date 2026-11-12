/**
 * Core standard SObjects of the Industries clouds (Financial Services Cloud,
 * Revenue Cloud / Revenue Lifecycle Management, Insurance). Backstop for the
 * live-org object extractor: Salesforce's EntityDefinition flags
 * (IsCustomizable / IsApexTriggerable / IsCustomSetting) can all read false
 * for these, and when the EntityDefinition probe fails the static
 * STANDARD_SOBJECT_WHITELIST has none of them.
 *
 * Only consulted for names describeGlobal actually lists, so an org without
 * the cloud pays no extra describe calls.
 */
export const INDUSTRIES_STANDARD_SOBJECTS: ReadonlySet<string> = new Set([
  // Financial Services Cloud (core, non-FinServ__ namespace)
  "FinancialAccount",
  "FinancialAccountParty",
  "FinancialAccountTransaction",
  "FinancialGoal",
  "FinancialHolding",
  "FinancialSecurity",
  "AssetsAndLiabilities",
  "PartyProfile",
  "PartyFinancialGoal",
  "PartyIncome",
  "PartyExpense",
  "FinancialAccountBalance",
  // Revenue Cloud / Revenue Lifecycle Management
  "ProductSellingModel",
  "ProductSellingModelOption",
  "ProductAttributeDefinition",
  "ProductClassification",
  "ProductClassificationAttr",
  "ProductCategory",
  "ProductCategoryProduct",
  "ProductCatalog",
  "ProductRelatedComponent",
  "ProductComponentGroup",
  "AttributeDefinition",
  "AttributeCategory",
  "AttributePicklist",
  "AttributePicklistValue",
  "PriceAdjustmentSchedule",
  "PriceAdjustmentTier",
  "UnitOfMeasure",
  // Insurance
  "InsurancePolicy",
  "InsurancePolicyAsset",
  "InsurancePolicyCoverage",
  "InsurancePolicyParticipant",
  "InsurancePolicyTransaction",
  "Claim",
  "ClaimCoverage",
  "ClaimItem",
  "ClaimParticipant",
  "Producer",
  "BusinessLicense",
]);
