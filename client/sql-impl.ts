import { createServerPromise, createServerChannel } from "mobius";
import { Record } from "sql";
import { Redacted } from "redact";

export function execute(host: string | Redacted<string>, sql: string | Redacted<string>, params?: any[] | Redacted<any[]>, stream?: (record: Record) => void) : Promise<Record[]> {
	const records: Record[] = [];
	const channel = createServerChannel((record: Record) => {
		records.push(record);
		if (stream) {
			stream(record);
		}
	});
	return createServerPromise<void>().then(value => {
		channel.close();
		return records;
	}, error => {
		channel.close();
		throw error;
	});
}
