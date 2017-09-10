import * as impl from "sql-impl";

export const execute = impl.execute;

export type ExecuteResult = { records?: { [column: string] : any}[], insertId?: number, affectedRows?: number };
export const query: (host: string, query: string, ...params: any[]) => Promise<{[column: string] : any}[]> = function(this: typeof impl) { 
	return execute.apply(this, Array.prototype.slice.call(arguments)).then((result: ExecuteResult) => {
		if (result.records) {
			return result.records;
		}
		throw new Error("Expected records on query!");
	});
}

export const modify: (host: string, sql: string, ...params: any[]) => Promise<{insertId?: number, affectedRows: number}> = function(this: typeof impl) {
	return execute.apply(this, Array.prototype.slice.call(arguments)).then((result: ExecuteResult) => {
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
