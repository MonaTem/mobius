/// <reference path="concurrence.ts" />

namespace concurrence {
	export const random = concurrence.receiveServerPromise as () => Promise<number>;
}
