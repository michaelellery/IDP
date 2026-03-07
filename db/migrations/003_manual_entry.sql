BEGIN;
CREATE TABLE IF NOT EXISTS document_type_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_type VARCHAR(50) NOT NULL,
    version VARCHAR(10) NOT NULL DEFAULT '1.0',
    field_schema JSONB NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_template_type_version UNIQUE (document_type, version)
);

CREATE TABLE IF NOT EXISTS review_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL,
    reviewer_id VARCHAR(64) NOT NULL,
    draft_data JSONB NOT NULL DEFAULT '{}',
    mode VARCHAR(20) NOT NULL DEFAULT 'review',
    document_type VARCHAR(50),
    save_count INTEGER NOT NULL DEFAULT 0,
    last_saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours'),
    CONSTRAINT uq_draft_document_reviewer UNIQUE (document_id, reviewer_id)
);
CREATE INDEX IF NOT EXISTS idx_drafts_document ON review_drafts(document_id);
CREATE INDEX IF NOT EXISTS idx_drafts_expires ON review_drafts(expires_at);

ALTER TABLE hitl_reviews ADD COLUMN IF NOT EXISTS field_provenance JSONB;
ALTER TABLE hitl_reviews ADD COLUMN IF NOT EXISTS entry_mode VARCHAR(20);

INSERT INTO document_type_templates (document_type, version, field_schema, is_active)
VALUES ('paystub', '1.0', '{"fieldGroups":[{"name":"Employee","order":1,"fields":[{"key":"employeesFullName","label":"Employee Full Name","type":"text","required":true,"order":1},{"key":"ssn","label":"SSN","type":"ssn","required":false,"order":2},{"key":"address","label":"Address","type":"text","required":false,"order":3}]},{"name":"Employer","order":2,"fields":[{"key":"employersName","label":"Employer Name","type":"text","required":false,"order":1},{"key":"employersAddress","label":"Employer Address","type":"text","required":false,"order":2},{"key":"employersPhoneNumber","label":"Employer Phone","type":"text","required":false,"order":3},{"key":"employersEin","label":"Employer EIN","type":"ein","required":false,"order":4}]},{"name":"Pay Period","order":3,"fields":[{"key":"payPeriodStartDate","label":"Pay Period Start","type":"date","required":false,"order":1},{"key":"payPeriodEndDate","label":"Pay Period End","type":"date","required":false,"order":2},{"key":"payDate","label":"Pay Date","type":"date","required":false,"order":3}]},{"name":"Earnings","order":4,"fields":[{"key":"grossPay","label":"Gross Pay","type":"currency","required":true,"order":1},{"key":"netPay","label":"Net Pay","type":"currency","required":true,"order":2},{"key":"ytdGrossEarnings","label":"YTD Gross Earnings","type":"currency","required":false,"order":3},{"key":"ytdNetEarnings","label":"YTD Net Earnings","type":"currency","required":false,"order":4}]},{"name":"Taxes","order":5,"fields":[{"key":"federalTaxWithheld","label":"Federal Tax Withheld","type":"currency","required":false,"order":1},{"key":"stateTaxWithheld","label":"State Tax Withheld","type":"currency","required":false,"order":2},{"key":"socialSecurityWithheld","label":"Social Security Withheld","type":"currency","required":false,"order":3},{"key":"medicareWithheld","label":"Medicare Withheld","type":"currency","required":false,"order":4}]}]}', true)
ON CONFLICT (document_type, version) DO NOTHING;

INSERT INTO document_type_templates (document_type, version, field_schema, is_active)
VALUES ('w2', '1.0', '{"fieldGroups":[{"name":"Employee","order":1,"fields":[{"key":"employeesFullName","label":"Employee Full Name","type":"text","required":true,"order":1},{"key":"ssn","label":"SSN","type":"ssn","required":true,"order":2},{"key":"address","label":"Address","type":"text","required":false,"order":3}]},{"name":"Employer","order":2,"fields":[{"key":"employersName","label":"Employer Name","type":"text","required":true,"order":1},{"key":"ein","label":"EIN","type":"ein","required":true,"order":2}]},{"name":"Wages","order":3,"fields":[{"key":"wagesTipsComp","label":"Wages, Tips, Compensation","type":"currency","required":true,"order":1},{"key":"federalTaxWithheld","label":"Federal Tax Withheld","type":"currency","required":true,"order":2},{"key":"socialSecurityWages","label":"Social Security Wages","type":"currency","required":false,"order":3},{"key":"socialSecurityTax","label":"Social Security Tax","type":"currency","required":false,"order":4},{"key":"medicareWages","label":"Medicare Wages","type":"currency","required":false,"order":5},{"key":"medicareTax","label":"Medicare Tax","type":"currency","required":false,"order":6}]},{"name":"State","order":4,"fields":[{"key":"stateWages","label":"State Wages","type":"currency","required":false,"order":1},{"key":"stateTax","label":"State Tax","type":"currency","required":false,"order":2},{"key":"stateId","label":"State ID","type":"text","required":false,"order":3}]}]}', true)
ON CONFLICT (document_type, version) DO NOTHING;

INSERT INTO document_type_templates (document_type, version, field_schema, is_active)
VALUES ('bank_statement', '1.0', '{"fieldGroups":[{"name":"Account","order":1,"fields":[{"key":"accountHolderName","label":"Account Holder Name","type":"text","required":true,"order":1},{"key":"accountNumber","label":"Account Number","type":"text","required":false,"order":2},{"key":"bankName","label":"Bank Name","type":"text","required":false,"order":3}]},{"name":"Period","order":2,"fields":[{"key":"statementStartDate","label":"Statement Start Date","type":"date","required":true,"order":1},{"key":"statementEndDate","label":"Statement End Date","type":"date","required":true,"order":2}]},{"name":"Balances","order":3,"fields":[{"key":"beginningBalance","label":"Beginning Balance","type":"currency","required":true,"order":1},{"key":"endingBalance","label":"Ending Balance","type":"currency","required":true,"order":2},{"key":"totalDeposits","label":"Total Deposits","type":"currency","required":false,"order":3},{"key":"totalWithdrawals","label":"Total Withdrawals","type":"currency","required":false,"order":4}]}]}', true)
ON CONFLICT (document_type, version) DO NOTHING;

INSERT INTO document_type_templates (document_type, version, field_schema, is_active)
VALUES ('tax_return', '1.0', '{"fieldGroups":[{"name":"Taxpayer","order":1,"fields":[{"key":"taxpayerName","label":"Taxpayer Name","type":"text","required":true,"order":1},{"key":"ssn","label":"SSN","type":"ssn","required":true,"order":2},{"key":"filingStatus","label":"Filing Status","type":"text","required":false,"order":3}]},{"name":"Income","order":2,"fields":[{"key":"totalIncome","label":"Total Income","type":"currency","required":true,"order":1},{"key":"adjustedGrossIncome","label":"Adjusted Gross Income","type":"currency","required":true,"order":2},{"key":"taxableIncome","label":"Taxable Income","type":"currency","required":false,"order":3}]},{"name":"Tax","order":3,"fields":[{"key":"totalTax","label":"Total Tax","type":"currency","required":false,"order":1},{"key":"totalPayments","label":"Total Payments","type":"currency","required":false,"order":2},{"key":"refundAmount","label":"Refund Amount","type":"currency","required":false,"order":3},{"key":"amountOwed","label":"Amount Owed","type":"currency","required":false,"order":4}]}]}', true)
ON CONFLICT (document_type, version) DO NOTHING;

INSERT INTO document_type_templates (document_type, version, field_schema, is_active)
VALUES ('photo_id', '1.0', '{"fieldGroups":[{"name":"Identity","order":1,"fields":[{"key":"fullName","label":"Full Name","type":"text","required":true,"order":1},{"key":"dateOfBirth","label":"Date of Birth","type":"date","required":true,"order":2},{"key":"idNumber","label":"ID Number","type":"text","required":true,"order":3},{"key":"expirationDate","label":"Expiration Date","type":"date","required":false,"order":4}]},{"name":"Address","order":2,"fields":[{"key":"address","label":"Address","type":"text","required":false,"order":1},{"key":"state","label":"State","type":"text","required":false,"order":2},{"key":"zipCode","label":"Zip Code","type":"text","required":false,"order":3}]}]}', true)
ON CONFLICT (document_type, version) DO NOTHING;

INSERT INTO document_type_templates (document_type, version, field_schema, is_active)
VALUES ('1099', '1.0', '{"fieldGroups":[{"name":"Recipient","order":1,"fields":[{"key":"recipientName","label":"Recipient Name","type":"text","required":true,"order":1},{"key":"recipientTin","label":"Recipient TIN","type":"ssn","required":true,"order":2}]},{"name":"Payer","order":2,"fields":[{"key":"payerName","label":"Payer Name","type":"text","required":true,"order":1},{"key":"payerTin","label":"Payer TIN","type":"ein","required":false,"order":2}]},{"name":"Income","order":3,"fields":[{"key":"nonemployeeCompensation","label":"Nonemployee Compensation","type":"currency","required":true,"order":1},{"key":"federalTaxWithheld","label":"Federal Tax Withheld","type":"currency","required":false,"order":2},{"key":"stateTaxWithheld","label":"State Tax Withheld","type":"currency","required":false,"order":3}]}]}', true)
ON CONFLICT (document_type, version) DO NOTHING;

COMMIT;
