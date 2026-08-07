import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('memory collage asset catalog', () => {
  it('registers every supplied transparent board and sticker source', () => {
    const boardFiles = readdirSync('design/board', { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.png');
    const categoryDirectories = readdirSync('design/stickers', { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    const stickerFiles = categoryDirectories.flatMap((category) => readdirSync(join('design/stickers', category.name), { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.png'));
    const migration = readFileSync('server/migrations/020_memory_collage_assets.sql', 'utf8');
    const fixedBoundsMigration = readFileSync('server/migrations/021_memory_collage_fixed_board_bounds.sql', 'utf8');
    const catalogGenerator = readFileSync('scripts/prepare-memory-collage-assets.mjs', 'utf8');
    const incrementalBoardGenerator = readFileSync('scripts/prepare-memory-collage-board.mjs', 'utf8');

    expect(boardFiles).toHaveLength(7);
    expect(categoryDirectories).toHaveLength(10);
    expect(stickerFiles).toHaveLength(192);
    expect(migration.match(/memory-collage\/boards\/board-\d{2}\.webp/g)).toHaveLength(7);
    expect(migration.match(/memory-collage\/stickers\/category-\d{2}\/sticker-\d{2}-\d{3}\.webp/g)).toHaveLength(192);
    expect(migration).toContain('editable_left');
    expect(migration).toContain('editable_bottom');
    expect(migration).not.toContain('9.8元加入会员全店免费');
    expect(fixedBoundsMigration).toContain('editable_left = 0.045000');
    expect(fixedBoundsMigration).toContain('editable_top = 0.130000');
    expect(fixedBoundsMigration).toContain('editable_right = 0.955000');
    expect(fixedBoundsMigration).toContain('editable_bottom = 0.945000');
    for (const generator of [catalogGenerator, incrementalBoardGenerator]) {
      expect(generator).toContain('left: 0.045');
      expect(generator).toContain('top: 0.13');
      expect(generator).toContain('right: 0.955');
      expect(generator).toContain('bottom: 0.945');
    }
    expect(incrementalBoardGenerator).toContain('Refusing to overwrite existing migration');
  });
});
