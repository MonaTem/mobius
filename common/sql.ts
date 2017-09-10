import * as impl from "sql-impl";

export const execute = impl.execute;

export type ExecuteResult = { records?: { [column: string] : any}[], insertId?: number, affectedRows?: number };
export function query(host: string, query: string, params?: any[]) : Promise<{[column: string] : any}[]> { 
	return execute(host, query, params).then((result: ExecuteResult) => {
		if (result.records) {
			return result.records;
		}
		throw new Error("Expected records on query!");
	});
}

export function modify(host: string, sql: string, params?: any[]) : Promise<{insertId?: number, affectedRows: number}> {
	return execute(host, sql, params).then((result: ExecuteResult) => {
		if (typeof result.affectedRows == "number") {
			let wrappedResult : {insertId?: number, affectedRows: number} = { affectedRows: result.affectedRows };
			if (typeof result.insertId == "number") {
				wrappedResult.insertId = result.insertId;
			}
			return wrappedResult;
		}
		throw new Error("Expected affectedRows on modify!");
	});
}
