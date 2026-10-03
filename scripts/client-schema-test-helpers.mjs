import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';

export function createClientSchemaValidator() {
  return new Ajv2020({ strictSchema: true, strictTypes: false, validateSchema: true });
}

export function assertClientToolSchemas(tools, validator) {
  let schemaCount = 0;
  for (const tool of tools) {
    for (const field of ['inputSchema', 'outputSchema']) {
      const schema = tool[field];
      if (!schema) continue;
      assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${tool.name}.${field}`);
      assert.doesNotThrow(() => validator.compile(schema), `${tool.name}.${field} must compile in a 2020-12 client`);
      schemaCount += 1;
    }
  }
  assert.ok(schemaCount > tools.length, 'input and output schemas must remain advertised');
  return schemaCount;
}
