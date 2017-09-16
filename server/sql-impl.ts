import { createServerPromise, secrets } from "mobius";
import { JsonMap } from "mobius-types";
import { ExecuteResult } from "sql";
import { peek, Redacted } from "redact";

declare global {
	namespace NodeJS {
		interface Global {
			mysqlPools?: { [name: string] : any };
		}
	}
}

function getPool(host: string) {
	const pools = global.mysqlPools || (global.mysqlPools = {});
	let pool = pools[host];
	if (!pool) {
		const mysqlSecrets = secrets["mysql"] as { [host: string] : any } | undefined;
		if (!mysqlSecrets) {
			throw new Error("Missing mysql config in secrets.json!");
		}
		const hostSecrets = mysqlSecrets[host] as { [field: string] : string } | undefined;
		if (!hostSecrets) {
			throw new Error("Missing mysql config for " + host + " in secrets.json!");
		}
		pool = pools[host] = require("mysql").createPool(hostSecrets);
	}
	return pool;
}

export function execute(host: string | Redacted<string>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>) : Promise<ExecuteResult> {
	return createServerPromise(() => new Promise<ExecuteResult & JsonMap>((resolve, reject) => {
		getPool(peek(host)).query({
			sql: peek(sql),
			values: params ? peek(params) : []
		}, (error: any, result: any) => {
			if (error) {
				reject(error);
			} else {
				let wrappedResult : ExecuteResult & JsonMap = {};
				if (result instanceof Array) {
					wrappedResult.records = result;
				} else {
					if (typeof result.insertId == "number") {
						wrappedResult.insertId = result.insertId;
					}
					if (typeof result.affectedRows == "number") {
						wrappedResult.affectedRows = result.affectedRows;
					}
				}
				resolve(wrappedResult);
			}
		});
	}));
}
