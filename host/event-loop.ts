export function defer() : Promise<void>;
export function defer<T>() : Promise<T>;
export function defer(value?: any) : Promise<any> {
	return new Promise<any>(resolve => setImmediate(resolve.bind(null, value)));
}

export function escape(e: any) {
	setImmediate(() => {
		throw e;
	});
}

export function escaping(handler: () => any | Promise<any>) : () => Promise<void>;
export function escaping<T>(handler: (value: T) => any | Promise<any>) : (value: T) => Promise<T | void>;
export function escaping(handler: (value?: any) => any | Promise<any>) : (value?: any) => Promise<any> {
	return async (value?: any) => {
		try {
			return await handler(value);
		} catch(e) {
			escape(e);
		}
	};
}

