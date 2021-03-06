import { Redacted } from "redact";
import { execute } from "sql-impl";

export const query = execute;

export interface Credentials {
	host: string;
	user: string;
	password?: string;
}

export interface Record { [column: string]: any; }

export async function modify(credentials: Redacted<Credentials | undefined>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>): Promise<{insertId?: number, affectedRows: number}> {
	const results = await execute(credentials, sql, params);
	const record = results[0];
	if (!record) {
		throw new Error("Did not receive a record describing the modify status!");
	}
	if (typeof record.affectedRows != "number") {
		throw new Error("Expected affectedRows on modify!");
	}
	const result: {insertId?: number, affectedRows: number} = { affectedRows: record.affectedRows };
	if (typeof record.insertId == "number") {
		result.insertId = record.insertId;
	}
	return result;
}
