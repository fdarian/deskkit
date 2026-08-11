import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Fixture schema for `sqlite.test.ts` — stands in for one consumer domain's tables. */
export const widgetsA = sqliteTable('widgets_a', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
});
