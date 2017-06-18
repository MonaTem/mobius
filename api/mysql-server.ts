//import * as uuid from "uuid";
const mysql = require("mysql");

declare module NodeJS  {
	interface Global {
		mysqlPools: { [name: string] : any } | undefined;
	}
}

namespace concurrence {
	export namespace mysql {
		function getPool(host: string) {
			const pools = global.mysqlPools || (global.mysqlPools = {});
			let pool = pools[host];
			if (!pool) {
				const mysqlSecrets = concurrence.secrets["mysql"];
				if (!mysqlSecrets) {
					return Promise.reject(new Error("Missing mysql config in secrets.json!"));
				}
				const hostSecrets = mysqlSecrets[host] as { [field: string] : string } | undefined;
				if (!hostSecrets) {
					return Promise.reject(new Error("Missing mysql config for " + host + " in secrets.json!"));
				}
				pool = pools[host] = require("mysql").createPool(hostSecrets);
			}
			return Promise.resolve(pool);
		}
		export function query(host: string, query: string, ...params: any[]) : Promise<{ [column: string] : any}[]> {
			return concurrence.observeServerPromise(getPool(host).then(pool => new Promise((resolve, reject) => {
				pool.query({
					sql: query,
					values: params
				}, (error: any, results: { [column: string] : any}[]) => {
					if (error) {
						reject(error);
					} else {
						resolve(results);
					}
				});
			})));
		}
	}
}
