/// <reference path="concurrence.ts" />

namespace concurrence {
	export const random = () => concurrence.observeServerPromise<number>(Math.random());
}
