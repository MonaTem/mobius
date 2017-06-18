namespace concurrence {
	export namespace mysql {
		export const query = concurrence.receiveServerPromise as (host: string, query: string) => Promise<{ [column: string] : any}[]>;
	}
}
