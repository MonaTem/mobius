import { createServerPromise, createServerChannel, secrets } from "mobius";
import { Record } from "sql";
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

export function execute(host: string | Redacted<string>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>) : Promise<Record[]>;
export function execute<T>(host: string | Redacted<string>, sql: string | Redacted<string>, params: any[] | Redacted<any[]>, stream: (record: Record) => T) : Promise<T[]>;
export function execute(host: string | Redacted<string>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>, stream?: (record: Record) => any) : Promise<any[]> {
	const records: Record[] = [];
	let send: ((record: Record) => void) | undefined;
	const channel = createServerChannel((record: Record) => {
		records.push(stream ? stream(record) : record);
	}, (newSend: (record: Record) => void) => send = newSend);
	return createServerPromise(() => new Promise<void>((resolve, reject) => {
		const query = getPool(peek(host)).query({
			sql: peek(sql),
			values: params ? peek(params) : []
		})
		query.on("result", (record: any) => send!(Object.assign({}, record)));
		query.on("end", resolve);
		query.on("error", reject);
	})).then(value => {
		channel.close();
		return records;
	}, error => {
		channel.close();
		throw error;
	});
}
