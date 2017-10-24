export default function memoize<T extends Function>(func: T) : T {
	const values = new Map<any, any>();
	return function(this: any, input: any) {
		if (values.has(input)) {
			return values.get(input);
		}
		const result = func.apply(this, arguments);
		values.set(input, result);
		return result;
	} as any as T;
}
