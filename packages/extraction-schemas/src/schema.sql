-- IDP Document Processing Schema
-- Aurora PostgreSQL

-- Core platform tables
CREATE TABLE decomposition (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    master_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE categorization (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    category_name VARCHAR(255),
    confidence DECIMAL(5,4),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE document_tampering (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    tampering_message TEXT,
    flagged BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE human_in_the_loop (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    message TEXT,
    status VARCHAR(50) DEFAULT 'PENDING',
    assigned_to VARCHAR(255),
    sla_deadline TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE response_time (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    total_time DECIMAL(15,4) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE user_feedback (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    feedback TEXT NOT NULL,
    feedback_type VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Document metadata (common to all doc types)
CREATE TABLE document_metadata (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    matter_id VARCHAR(255) NOT NULL,
    document_type VARCHAR(100) NOT NULL,
    confidence DECIMAL(5,4),
    status VARCHAR(50) DEFAULT 'PROCESSING',
    s3_key VARCHAR(1024),
    source_channel VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_doc_metadata_matter ON document_metadata(matter_id);
CREATE INDEX idx_doc_metadata_status ON document_metadata(status);

-- Per-document-type extraction tables

CREATE TABLE paystub (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    employees_full_name VARCHAR(255),
    address TEXT,
    ssn VARCHAR(11),
    employers_name VARCHAR(255),
    employers_address TEXT,
    employers_phone_number VARCHAR(20),
    employers_ein VARCHAR(20),
    pay_period_start_date DATE,
    pay_period_end_date DATE,
    pay_date DATE,
    gross_pay DECIMAL(15,2),
    net_pay DECIMAL(15,2),
    ytd_gross_earnings DECIMAL(15,2),
    ytd_net_earnings DECIMAL(15,2),
    date_of_issue DATE
);

CREATE TABLE photoid (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    id_type VARCHAR(50) CHECK (id_type IN ('Driver License','Passport','Military','State ID','Other')),
    issuing_authority VARCHAR(255),
    issuing_date DATE,
    expiration_date DATE,
    id_number VARCHAR(50),
    first_name VARCHAR(100),
    middle_name VARCHAR(100),
    last_name VARCHAR(100),
    date_of_birth DATE,
    gender CHAR(1) CHECK (gender IN ('M','F','O')),
    address VARCHAR(500),
    barcode VARCHAR(255)
);

CREATE TABLE insuranceproof (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    policy_holder_full_name VARCHAR(255),
    policy_holder_address VARCHAR(500),
    date_of_birth DATE,
    policy_holder_contact_info VARCHAR(500),
    insurance_company_name VARCHAR(255),
    insurance_company_address VARCHAR(500),
    claims_contact_info VARCHAR(500),
    agent_broker_name VARCHAR(255),
    policy_number VARCHAR(100),
    policy_start_date DATE,
    policy_end_date DATE,
    type_of_coverage VARCHAR(255),
    asset_description TEXT,
    asset_identification VARCHAR(255),
    state_or_jurisdiction VARCHAR(100),
    date_of_issue DATE
);

CREATE TABLE bankstatement (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    account_holder_name VARCHAR(255),
    account_number VARCHAR(50),
    bank_name VARCHAR(255),
    bank_branch_address VARCHAR(500),
    bank_contact_info VARCHAR(500),
    statement_period_start_date DATE,
    statement_period_end_date DATE,
    date_of_issue DATE,
    opening_balance DECIMAL(20,2),
    closing_balance DECIMAL(20,2),
    total_deposits DECIMAL(20,2),
    total_withdrawals DECIMAL(20,2)
);

CREATE TABLE vehicleregistration (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    owner_full_name VARCHAR(255),
    owner_address VARCHAR(500),
    contact_info VARCHAR(500),
    date_of_birth DATE,
    vin VARCHAR(50),
    license_plate_number VARCHAR(20),
    vehicle_make VARCHAR(100),
    vehicle_model VARCHAR(100),
    vehicle_year INT,
    vehicle_color VARCHAR(50),
    insurance_policy_number VARCHAR(50),
    insurer_name VARCHAR(255)
);

CREATE TABLE voidedcheck (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    bank_name VARCHAR(255),
    bank_address VARCHAR(500),
    routing_number VARCHAR(15),
    account_holder_name VARCHAR(255),
    account_number VARCHAR(50),
    check_number VARCHAR(20),
    micr_line VARCHAR(100),
    memo_line VARCHAR(255),
    signature_line VARCHAR(255)
);

CREATE TABLE taxreturn (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    tax_year INT,
    adjusted_gross_income DECIMAL(20,2),
    total_income DECIMAL(20,2),
    wages_salaries_tips DECIMAL(20,2),
    interest_income DECIMAL(20,2),
    dividend_income DECIMAL(20,2),
    capital_gains_losses DECIMAL(20,2),
    business_income_loss DECIMAL(20,2),
    real_estate_income_loss DECIMAL(20,2),
    other_income DECIMAL(20,2),
    total_tax DECIMAL(20,2),
    full_name VARCHAR(255),
    ssn_or_tin VARCHAR(15),
    date_of_birth DATE,
    filing_status VARCHAR(50),
    address VARCHAR(500),
    phone_number VARCHAR(20),
    email_address VARCHAR(255)
);

CREATE TABLE vehiclepicture_vin (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    vin VARCHAR(50)
);

CREATE TABLE vehiclepicture_odometer (
    document_name VARCHAR(255) NOT NULL PRIMARY KEY,
    odometer_reading DECIMAL(10,1)
);

CREATE TABLE vehiclepicture_front (document_name VARCHAR(255) NOT NULL PRIMARY KEY);
CREATE TABLE vehiclepicture_rear (document_name VARCHAR(255) NOT NULL PRIMARY KEY);
CREATE TABLE vehiclepicture_driver (document_name VARCHAR(255) NOT NULL PRIMARY KEY);
CREATE TABLE vehiclepicture_passenger (document_name VARCHAR(255) NOT NULL PRIMARY KEY);
