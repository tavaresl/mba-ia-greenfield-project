import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  describe('videos endpoints', () => {
    type Operation = {
      tags?: string[];
      summary?: string;
      security?: Array<Record<string, unknown>>;
      responses: Record<
        string,
        { content?: Record<string, { schema?: { $ref?: string } }> }
      >;
    };
    const ERROR_REF = '#/components/schemas/ApiErrorEnvelope';

    // [method, path, success status, error statuses it must declare]
    const VIDEO_OPERATIONS: [string, string, string, string[]][] = [
      ['post', '/videos', '201', ['400', '401']],
      [
        'post',
        '/videos/{publicId}/upload/parts',
        '200',
        ['400', '401', '404', '409'],
      ],
      ['get', '/videos/{publicId}/upload/parts', '200', ['401', '404', '409']],
      [
        'post',
        '/videos/{publicId}/upload/complete',
        '202',
        ['400', '401', '404', '409', '422'],
      ],
      ['delete', '/videos/{publicId}/upload', '204', ['401', '404', '409']],
      ['get', '/videos/{publicId}', '200', ['401', '404']],
      ['get', '/videos/{publicId}/stream', '302', ['401', '404', '409']],
      ['get', '/videos/{publicId}/download', '302', ['401', '404', '409']],
    ];

    const operationOf = (method: string, path: string) =>
      (document.paths as Record<string, Record<string, Operation>>)[path]?.[
        method
      ];

    it.each(VIDEO_OPERATIONS)(
      '%s %s is tagged videos, requires the access token and documents its responses',
      (method, path, success, errors) => {
        const operation = operationOf(method, path);

        expect(operation).toBeDefined();
        expect(operation.tags).toEqual(['videos']);
        expect(operation.summary).toBeTruthy();
        expect(operation.security?.some((req) => 'access-token' in req)).toBe(
          true,
        );
        expect(operation.responses[success]).toBeDefined();
        for (const status of errors) {
          expect(
            operation.responses[status]?.content?.['application/json']?.schema
              ?.$ref,
          ).toBe(ERROR_REF);
        }
      },
    );

    it('describes the request bodies of the video endpoints', () => {
      const schemas = (
        document.components as {
          schemas: Record<
            string,
            { properties: Record<string, unknown>; required?: string[] }
          >;
        }
      ).schemas;

      expect(Object.keys(schemas['CreateVideoDto'].properties).sort()).toEqual([
        'file_name',
        'file_size',
        'mime_type',
        'title',
      ]);
      expect(Object.keys(schemas['SignUploadPartsDto'].properties)).toEqual([
        'part_numbers',
      ]);
      expect(Object.keys(schemas['CompleteUploadDto'].properties)).toEqual([
        'parts',
      ]);
      expect(
        Object.keys(schemas['CompletedPartDto'].properties).sort(),
      ).toEqual(['etag', 'part_number']);
    });

    it('describes the status/metadata response of GET /videos/{publicId}', () => {
      const schemas = (
        document.components as {
          schemas: Record<string, { properties: Record<string, unknown> }>;
        }
      ).schemas;

      const properties = schemas['VideoResponseDto'].properties;
      expect(properties).toHaveProperty('status');
      expect(properties).toHaveProperty('duration_seconds');
      expect(properties).toHaveProperty('thumbnail_url');
    });
  });
});
