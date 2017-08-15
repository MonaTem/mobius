namespace concurrence {
	self.Math = Object.create(Math);
	const realRandom = concurrence.applyDeterminismWarning(Math, "random", "Math.random()", "concurrence.random()");
	export const random = () => concurrence.observeServerPromise<number>(realRandom());
}
