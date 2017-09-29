export default function memoize<I, O>(func: (input: I) => O) {
	const values = new Map<I, O>();
	return (input: I) => {
		if (values.has(input)) {
			return values.get(input) as O;
		}
		const result = func(input);
		values.set(input, result);
		return result;
	}
}
