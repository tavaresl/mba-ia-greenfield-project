import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1793065595069 } from './migrations/1793065595069-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

const MANAGED_ENUMS = ['verification_tokens_type_enum', 'videos_status_enum'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1793065595069,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential on purpose: parallel DROP ... CASCADE statements on different
    // pool connections deadlock on the FK chain (videos -> channels -> users).
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // Suites that use `synchronize` leave enum types behind; the migrations
    // create them with plain CREATE TYPE, so drop them before applying.
    for (const name of MANAGED_ENUMS) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${name}"`);
    }
  });

  afterAll(async () => {
    // The revert tests undo the last migrations, leaving tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  async function existingTables(tables: string[]): Promise<string[]> {
    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [tables],
    );
    return result.map((r) => r.table_name);
  }

  async function existingEnums(names: string[]): Promise<string[]> {
    const result = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = ANY($1::text[]) ORDER BY typname`,
      [names],
    );
    return result.map((r) => r.typname);
  }

  it('should apply all migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);
    expect(await existingTables(MANAGED_TABLES)).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should create the videos enum, the unique public_id index and the channel FK', async () => {
    expect(await existingEnums(['videos_status_enum'])).toEqual([
      'videos_status_enum',
    ]);

    const indexes = await dataSource.query<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'videos'`,
    );
    expect(
      indexes.some(
        (i) =>
          i.indexdef.includes('UNIQUE') && i.indexdef.includes('(public_id)'),
      ),
    ).toBe(true);
    expect(indexes.some((i) => i.indexdef.includes('(channel_id)'))).toBe(true);

    const foreignKeys = await dataSource.query<{ ref: string }[]>(
      `SELECT confrelid::regclass::text AS ref FROM pg_constraint
       WHERE conrelid = 'videos'::regclass AND contype = 'f'`,
    );
    expect(foreignKeys.map((f) => f.ref)).toEqual(['channels']);
  });

  it('should revert the videos migration and remove the table and enum', async () => {
    await dataSource.undoLastMigration();

    expect(await existingTables(['videos'])).toEqual([]);
    expect(await existingEnums(['videos_status_enum'])).toEqual([]);
  });

  it('should revert the auth tokens migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    expect(
      await existingTables(['refresh_tokens', 'verification_tokens']),
    ).toEqual([]);
  });
});
