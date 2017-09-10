interface Console {
    error(message?: any, ...optionalParams: any[]): void;
    info(message?: any, ...optionalParams: any[]): void;
    log(message?: any, ...optionalParams: any[]): void;
    warn(message?: any, ...optionalParams: any[]): void;
}

declare var console: Console;

declare type Timer = number & { $Timer: any };

declare function setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): Timer;
declare function clearTimeout(timeoutId: Timer): void;
declare function setInterval(callback: (...args: any[]) => void, ms: number, ...args: any[]): Timer;
declare function clearInterval(intervalId: Timer): void;
declare function setImmediate(callback: (...args: any[]) => void, ...args: any[]): any;
declare function clearImmediate(immediateId: any): void;
