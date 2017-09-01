namespace concurrence {
	export namespace mysql {
		export const execute = concurrence.createServerPromise as (host: string, sql: string, ...params: any[]) => Promise<ExecuteResult>;
	}
}
