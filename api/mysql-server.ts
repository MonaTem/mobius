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
		export function execute(host: string, sql: string, ...params: any[]) : Promise<ExecuteResult> {
			return createServerPromise(() => getPool(host).then(pool => new Promise<ExecuteResult & ConcurrenceJsonMap>((resolve, reject) => {
				pool.query({
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
			})));
		}
	}
}
