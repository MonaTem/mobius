self.Math = Object.create(Math);
Math.random = concurrence.coordinateValue.bind(null, Math.random.bind(Math));
