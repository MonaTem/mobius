namespace concurrence {
	export namespace mysql {
		export const execute = concurrence.receiveServerPromise as (host: string, sql: string, ...params: any[]) => Promise<ExecuteResult>;
	}
}
