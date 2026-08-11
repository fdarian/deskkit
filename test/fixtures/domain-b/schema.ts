import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Fixture schema for `sqlite.test.ts` — stands in for a second consumer domain sharing the same db file as `domain-a`. */
export const widgetsB = sqliteTable('widgets_b', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	label: text('label').notNull(),
});
