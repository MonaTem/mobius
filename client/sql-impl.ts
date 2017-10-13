import { createServerPromise, createServerChannel } from "mobius";
import { Credentials, Record } from "sql";
import { Redacted } from "redact";

export function execute(credentials: Redacted<Credentials | undefined>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>) : Promise<Record[]>;
export function execute<T>(credentials: Redacted<Credentials | undefined>, sql: string | Redacted<string>, params: any[] | Redacted<any[]>, stream: (record: Record) => T) : Promise<T[]>;
export function execute(credentials: Redacted<Credentials | undefined>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>, stream?: (record: Record) => any) : Promise<any[]> {
	const records: Record[] = [];
	const channel = createServerChannel((record: Record) => {
		records.push(stream ? stream(record) : record);
	});
	return createServerPromise<void>().then(value => {
		channel.close();
		return records;
	}, error => {
		channel.close();
		throw error;
	});
}
