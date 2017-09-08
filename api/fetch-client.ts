namespace concurrence {
	export const fetch = createServerPromise as (url: string, options?: FetchOptions) => PromiseLike<FetchResponse>;
}
