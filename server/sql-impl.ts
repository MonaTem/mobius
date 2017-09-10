import { createServerPromise, secrets } from "concurrence";
import { ConcurrenceJsonMap } from "concurrence-types";
import { ExecuteResult } from "sql";

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

export function execute(host: string, sql: string, ...params: any[]) : Promise<ExecuteResult> {
	return createServerPromise(() => new Promise<ExecuteResult & ConcurrenceJsonMap>((resolve, reject) => {
		getPool(host).query({
			sql: sql,
			values: params
		}, (error: any, result: any) => {
			if (error) {
				reject(error);
			} else {
				let wrappedResult : ExecuteResult & ConcurrenceJsonMap = {};
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
