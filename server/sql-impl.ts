import { createServerPromise, createServerChannel, secrets } from "mobius";
import { Credentials, Record } from "sql";
import { peek, Redacted } from "redact";

declare global {
	namespace NodeJS {
		interface Global {
			mysqlPools?: Map<Credentials, any>;
		}
	}
}

function getPool(credentials: Redacted<Credentials | undefined>) {
	const pools = global.mysqlPools || (global.mysqlPools = new Map<Credentials, any>());
	const peeked = peek(credentials);
	let pool = pools.get(peeked);
	if (!pool) {
		if (!peeked || !peeked.host) {
			throw new Error("Invalid SQL credentials!");
		}
		pool = require("mysql").createPool(peeked);
		pools.set(peeked, pool);
	}
	return pool;
}

export function execute(credentials: Redacted<Credentials | undefined>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>) : Promise<Record[]>;
export function execute<T>(credentials: Redacted<Credentials | undefined>, sql: string | Redacted<string>, params: any[] | Redacted<any[]>, stream: (record: Record) => T) : Promise<T[]>;
export function execute(credentials: Redacted<Credentials | undefined>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>, stream?: (record: Record) => any) : Promise<any[]> {
	const records: Record[] = [];
	let send: ((record: Record) => void) | undefined;
	const channel = createServerChannel((record: Record) => {
		records.push(stream ? stream(record) : record);
	}, (newSend: (record: Record) => void) => send = newSend);
	return createServerPromise(() => new Promise<void>((resolve, reject) => {
		const query = getPool(credentials).query({
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
