export const PAYSTUB_FIELDS = [
  { name: 'employees_full_name', type: 'string', description: 'Full name of the employee' },
  { name: 'address', type: 'string', description: 'Employee mailing address' },
  { name: 'ssn', type: 'string', description: 'Social Security Number (format: XXX-XX-XXXX)' },
  { name: 'employers_name', type: 'string', description: 'Name of the employer/company' },
  { name: 'employers_address', type: 'string', description: 'Employer mailing address' },
  { name: 'employers_phone_number', type: 'string', description: 'Employer phone number' },
  { name: 'employers_ein', type: 'string', description: 'Employer Identification Number (EIN)' },
  { name: 'pay_period_start_date', type: 'date', description: 'Start date of pay period (YYYY-MM-DD)' },
  { name: 'pay_period_end_date', type: 'date', description: 'End date of pay period (YYYY-MM-DD)' },
  { name: 'pay_date', type: 'date', description: 'Date payment was issued (YYYY-MM-DD)' },
  { name: 'gross_pay', type: 'number', description: 'Gross pay amount for this period (decimal)' },
  { name: 'net_pay', type: 'number', description: 'Net pay amount for this period (decimal)' },
  { name: 'ytd_gross_earnings', type: 'number', description: 'Year-to-date gross earnings (decimal)' },
  { name: 'ytd_net_earnings', type: 'number', description: 'Year-to-date net earnings (decimal)' },
  { name: 'date_of_issue', type: 'date', description: 'Date the paystub was issued (YYYY-MM-DD)' },
] as const;

export const PAYSTUB_EXTRACTION_PROMPT = `You are a document data extraction specialist. Extract the following fields from this paystub image.

For each field, provide:
- The extracted value (use null if not found)
- A confidence score from 0.0 to 1.0

Fields to extract:
${PAYSTUB_FIELDS.map(f => `- ${f.name}: ${f.description} (type: ${f.type})`).join('\n')}

Rules:
- Dates must be in YYYY-MM-DD format
- Dollar amounts should be numbers without $ or commas (e.g., 5432.10)
- SSN format: XXX-XX-XXXX
- If a field is partially visible or uncertain, set confidence < 0.7
- If a field is not present at all, set value to null and confidence to 0`;

export const PAYSTUB_TOOL_SCHEMA = {
  name: 'extract_paystub',
  description: 'Extract structured data from a paystub document',
  input_schema: {
    type: 'object' as const,
    properties: Object.fromEntries(
      PAYSTUB_FIELDS.map(f => [
        f.name,
        {
          type: 'object' as const,
          properties: {
            value: { type: f.type === 'number' ? 'number' : 'string', description: f.description, nullable: true },
            confidence: { type: 'number' as const, description: 'Confidence 0-1' },
          },
          required: ['value', 'confidence'],
        },
      ])
    ),
    required: PAYSTUB_FIELDS.map(f => f.name),
  },
};

export const PAYSTUB_RDS_INSERT = `
  INSERT INTO paystub (
    document_name, employees_full_name, address, ssn, employers_name, employers_address,
    employers_phone_number, employers_ein, pay_period_start_date, pay_period_end_date,
    pay_date, gross_pay, net_pay, ytd_gross_earnings, ytd_net_earnings, date_of_issue
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
  ON CONFLICT (document_name) DO UPDATE SET
    employees_full_name=$2, address=$3, ssn=$4, employers_name=$5, employers_address=$6,
    employers_phone_number=$7, employers_ein=$8, pay_period_start_date=$9, pay_period_end_date=$10,
    pay_date=$11, gross_pay=$12, net_pay=$13, ytd_gross_earnings=$14, ytd_net_earnings=$15, date_of_issue=$16
`;

export function paystubToRdsParams(documentName: string, extracted: Record<string, { value: any; confidence: number }>): any[] {
  return [
    documentName,
    extracted.employees_full_name?.value ?? null,
    extracted.address?.value ?? null,
    extracted.ssn?.value ?? null,
    extracted.employers_name?.value ?? null,
    extracted.employers_address?.value ?? null,
    extracted.employers_phone_number?.value ?? null,
    extracted.employers_ein?.value ?? null,
    extracted.pay_period_start_date?.value ?? null,
    extracted.pay_period_end_date?.value ?? null,
    extracted.pay_date?.value ?? null,
    extracted.gross_pay?.value ?? null,
    extracted.net_pay?.value ?? null,
    extracted.ytd_gross_earnings?.value ?? null,
    extracted.ytd_net_earnings?.value ?? null,
    extracted.date_of_issue?.value ?? null,
  ];
}
