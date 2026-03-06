# Contributing to IDP

Read this before writing a single line of code.

## Coding Standards

### Error Handling
- **Never swallow errors.** No empty catch blocks. No `.catch(() => {})`.
- Every catch block must log the error with context (Lambda name, operation, relevant IDs).
- Use the project logger, not `console.log`.

```typescript
// ❌ Never
try { await process(doc); } catch (e) {}

// ❌ Never
await process(doc).catch(() => {});

// ✅ Always
try {
  await process(doc);
} catch (error) {
  logger.error('Failed to process document', { error, documentId, lambdaName: 'classifier' });
  throw error; // or handle with a defined recovery path
}
```

### Database Queries
- **Parameterized queries only.** No string concatenation or template literals in query expressions.
- Use expression attribute names and values for DynamoDB.

```typescript
// ❌ Never
const params = { FilterExpression: `id = '${userId}'` };

// ✅ Always
const params = {
  FilterExpression: 'id = :userId',
  ExpressionAttributeValues: { ':userId': userId }
};
```

### Types
- **No `any`.** Define interfaces for every data shape.
- If you don't know the type, figure it out. `unknown` + type narrowing if you must.

```typescript
// ❌ Never
function process(doc: any): any { ... }

// ✅ Always
interface DocumentInput {
  id: string;
  content: Buffer;
  metadata: DocumentMetadata;
}
function process(doc: DocumentInput): ProcessingResult { ... }
```

### Secrets
- **AWS Secrets Manager only.** Never environment variables, never hardcoded.
- Use the shared `getSecret()` utility.

```typescript
// ❌ Never
const apiKey = process.env.API_KEY;
const password = 'hunter2';

// ✅ Always
const apiKey = await getSecret('idp/anthropic-api-key');
```

### Testing
- **Every Lambda must have unit tests.** No exceptions.
- Test the happy path, error paths, and edge cases.
- Mock external services (AWS SDK, APIs).

### Logging
- Use the structured logger. No raw `console.log`.
- Include context: Lambda name, request ID, document ID, operation.

## PR Process

1. Branch from `main`
2. Write code + tests
3. Fill out the PR template completely
4. Pass all CI checks
5. Get at least one approval
6. Squash merge

PRs that skip the checklist or fail CI will be closed without review.
