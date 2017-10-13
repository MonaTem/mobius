import { execute } from "sql-impl";
import { Redacted } from "redact";

export const query = execute;

export interface Credentials {
	host: string;
	user: string;
	password?: string;
}

export type Record = { [column: string] : any };

export function modify(credentials: Redacted<Credentials | undefined>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>) : Promise<{insertId?: number, affectedRows: number}> {
	return execute(credentials, sql, params).then((results: Record[]) => {
		const record = results[0];
		if (!record) {
			throw new Error("Did not receive a record describing the modify status!");
		}
		if (typeof record.affectedRows != "number") {
			throw new Error("Expected affectedRows on modify!");
		}
		const result : {insertId?: number, affectedRows: number} = { affectedRows: record.affectedRows };
		if (typeof record.insertId == "number") {
			result.insertId = record.insertId;
		}
		return result;
	});
}
