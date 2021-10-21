"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Runtime = exports.preloadRuntime = exports.setupErrorHandling = exports.HandlerLoader = exports.Errors = exports.Request = void 0;
const http = require("http");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const querystring = require('querystring');
const lambdaRuntimeRequestID = "Lambda-Runtime-Aws-Request-Id";
const lambdaRuntimeFunctionARN = "Lambda-Runtime-Invoked-Function-Arn";
const lambdaRuntimeFunctionName = "Lambda-Runtime-Function-Name";
const lambdaRuntimeFunctionVersion = "Lambda-Runtime-Function-Version";
const lambdaRuntimeMemoryLimit = "Lambda-Runtime-Memory-Limit";
const lambdaRuntimeDeadlineMs = "Lambda-Runtime-Deadline-Ms";
const lambdaRuntimeLogGroupName = "Lambda-Runtime-Log-Group-Name";
const lambdaRuntimeTokenJson = "Lambda-Runtime-Token-Json";
const sleep = (ms) => new Promise((resolve, reject) => setTimeout(resolve, ms));
// this value should be consistent with serverless/common/globals/timeout.go: MaxEngineRequestReadTimeout
const maxWaitSeconds = 30 * 60; // > 2.5 * maxExecutionTimeout + extra time
const agent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: maxWaitSeconds * 1000, // milliseconds, delay between the last data packet received and the first keepalive probe
});
function parseJsonSafe(v) {
    try {
        if (typeof (v) === "string") {
            return JSON.parse(v);
        }
    }
    catch (e) {
        return null;
    }
}
function parseJsonPayload(data) {
    try {
        return JSON.parse(data);
    }
    catch (e) {
        return {
            'payload': data,
        };
    }
}
/**
 * @see https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html
 */
class Request {
    constructor(headers, data) {
        this.requestId = this.awsRequestId = headers.get(lambdaRuntimeRequestID);
        this.invokedFunctionArn = headers.get(lambdaRuntimeFunctionARN);
        this.functionName = headers.get(lambdaRuntimeFunctionName);
        this.functionVersion = headers.get(lambdaRuntimeFunctionVersion);
        this.memoryLimitInMB = headers.get(lambdaRuntimeMemoryLimit);
        this.deadlineMs = Number.parseInt(headers.get(lambdaRuntimeDeadlineMs), 10);
        this.logGroupName = headers.get(lambdaRuntimeLogGroupName);
        this.token = parseJsonSafe(headers.get(lambdaRuntimeTokenJson));
        this._data = data;
    }
    // noinspection JSUnusedGlobalSymbols
    getRemainingTimeInMillis() {
        return this.deadlineMs - new Date().getTime();
    }
    /** @internal */
    getData() {
        return this._data;
    }
    getPayload() {
        if (!this._data.hasOwnProperty("headers")) {
            return Buffer.from([]);
        }
        let contentType = this._data["headers"]["Content-Type"];
        switch (contentType) {
            case "application/json":
                // never base64encoded
                if (this._data.hasOwnProperty("body")) {
                    return JSON.parse(this._data["body"]);
                }
                else {
                    return {};
                }
            case "application/x-www-form-urlencoded":
                if (this._data.hasOwnProperty("body")) {
                    if (this._data["isBase64Encoded"]) {
                        return querystring.parse(Buffer.from(this._data["body"], 'base64').toString());
                    }
                    else {
                        return querystring.parse(this._data["body"]);
                    }
                }
                else {
                    return {};
                }
            default:
                if (this._data.hasOwnProperty("body")) {
                    if (this._data["isBase64Encoded"]) {
                        return Buffer.from(this._data["body"], 'base64');
                    }
                    else {
                        return Buffer.from(this._data["body"]);
                    }
                }
                else {
                    return Buffer.from([]);
                }
        }
    }
}
exports.Request = Request;
class Errors {
    static cutStackRows(err) {
        if (!err.stack) {
            return [];
        }
        let rows = err.stack.split('\n');
        let matcher = /at \/function\/runtime\/bootstrap/;
        let idx = rows.findIndex(row => matcher.exec(row) != null);
        if (idx >= 1) {
            return rows.slice(1, idx);
        }
        return rows.slice(1);
    }
    static stackTrace(err) {
        let matcher = /at (?:(.+)\s+\()?(?:(.+?):(\d+)(?::(\d+))?|([^)]+))\)?/;
        return Errors.cutStackRows(err)
            .map((line) => {
            try {
                let m = matcher.exec(line);
                if (m != null) {
                    return {
                        function: m[1] || null,
                        file: m[2] || null,
                        line: parseInt(m[3], 10) || null,
                        column: parseInt(m[4], 10) || null
                    };
                }
            }
            catch (e) {
                // just ignore it, will return unparsed line
            }
            return { line: line };
        });
    }
    static errorJson(err) {
        return JSON.stringify({
            "errorMessage": err.message,
            "errorType": err.name,
            "stackTrace": Errors.stackTrace(err),
        });
    }
    static logError(err, prefix) {
        let msg = "[ERROR] ";
        if (prefix != null) {
            msg += prefix + " ";
        }
        msg += err;
        Errors.cutStackRows(err).forEach(row => {
            msg += "\r" + row;
        });
        process.stdout.write(msg + "\n");
    }
}
exports.Errors = Errors;
class HandlerLoader {
    constructor(runtimeRoot, taskRoot) {
        this.runtimeRoot = runtimeRoot;
        this.taskRoot = taskRoot;
    }
    load(handlerLocation) {
        let parts = handlerLocation.split(".", 2);
        let modPath;
        if (parts.length == 1) {
            modPath = this.taskRoot;
        }
        else if (parts.length == 2) {
            modPath = path.join(this.taskRoot, parts[0]);
            parts = parts.slice(1);
        }
        else {
            throw new Error(`Given handler '${handlerLocation}' is not valid for NodeJS function, it must be in form 'package.handlerFunctionName'`);
        }
        let mod = require(modPath);
        let handler = mod[parts[0]];
        if (!handler) {
            throw new Error(`Can't find handler function ${parts[0]} in ${modPath}`);
        }
        if (typeof handler !== "function") {
            throw new Error(`${handlerLocation} must be function`);
        }
        return handler;
    }
}
exports.HandlerLoader = HandlerLoader;
function setupErrorHandling() {
    // prevent nodejs from crashing on unhandled errors/rejections
    const uncaughtErrorListener = (error) => {
        // XXX: see https://nodejs.org/api/process.html#process_warning_using_uncaughtexception_correctly
        // XXX: uncaughtException/Rejection means that the code lost promise flow, which inherently mean that an application is in an undefined state (in other words the application hangs).
        // XXX: The event should not be used as an equivalent to On Error Resume Next.
        // XXX: Attempting to resume application code without properly recovering from the exception can cause additional unforeseen and unpredictable issues.
        try {
            Errors.logError(error, "Uncaught Error:");
        }
        catch (e) {
            // should never happen
            Errors.logError(e);
        }
        // XXX: never try to resume execution after uncaught errors - it's a crude mechanism for exception handling intended to be used only as a last resort.
        // TODO: introduce a special code so that bootstrap reaper will restart the application only
        // TODO: sleep(1sec); process.exec(112);
    };
    process.on('uncaughtException', uncaughtErrorListener);
    process.on('unhandledRejection', uncaughtErrorListener);
}
exports.setupErrorHandling = setupErrorHandling;
async function notifyStartAndAwaitReadiness(runtimeHost) {
    try {
        // phase 1: notify engine the runtime instance is ready preloaded)
        try {
            let urlReady = `http://${runtimeHost}/2018-06-01/runtime/init/ready`;
            while (true) {
                // retries (in case of vsock drops/timeouts)
                let resp = await fetch(urlReady, { agent: agent, method: 'post' });
                if (resp.ok) {
                    break;
                }
            }
        }
        finally {
            // DEBUG: console.log("init -> ready");
        }
        // phase 2: await for `start runtime` command processed by bootstrap
        try {
            let notifyChannel = '/var/run/.bootstrap.notify.runtime.start';
            if (fs.existsSync(notifyChannel)) {
                await fs.promises.readFile(notifyChannel);
            }
        }
        finally {
            // DEBUG: console.log("ready -> notified");
        }
        // phase 3: await for functions data (should be available after `start runtime`)
        try {
            let urlAwait = `http://${runtimeHost}/2018-06-01/runtime/init/await`;
            while (true) {
                // retries (in case of vsock drops/timeouts)
                let resp = await fetch(urlAwait, { agent });
                if (resp.ok) {
                    return await resp.json();
                }
            }
        }
        finally {
            // DEBUG: console.log("notified -> unblocked");
        }
    }
    catch (e) {
        Errors.logError(e);
        throw e;
    }
}
async function preloadRuntime(runtimeHost, handlerLoader, terminate, unbufferedContent) {
    if (process.env["X_YCF_RUNTIME_POOL"] !== undefined) {
        const resp = await notifyStartAndAwaitReadiness(runtimeHost);
        const environment = resp['environment'];
        if (environment !== undefined) {
            for (let [k, v] of Object.entries(environment)) {
                process.env[k] = v;
            }
        }
        process.env['_HANDLER'] = resp['entry_point'];
        process.chdir(process.env['LAMBDA_TASK_ROOT']); // make sure directory is the new /function/code (changed after mount)
    }
    return new Runtime(runtimeHost, handlerLoader, terminate, unbufferedContent);
}
exports.preloadRuntime = preloadRuntime;
class Runtime {
    constructor(runtimeHost, handlerLoader, terminate, unbufferedContent) {
        this.terminate = terminate;
        this.runtimeHost = runtimeHost;
        this.unbufferedContent = unbufferedContent;
        try {
            this.handler = handlerLoader();
        }
        catch (e) {
            Errors.logError(e);
            this.handleInitError(e)
                .then(() => {
                this.terminate(null);
            })
                .catch((e) => {
                Errors.logError(e);
                this.terminate(e);
            });
        }
    }
    async nextInvocation() {
        const url = `http://${this.runtimeHost}/2018-06-01/runtime/invocation/next`;
        while (true) {
            try {
                const invocation = await fetch(url, { agent }); // XXX: can throw own error
                switch (invocation.status) {
                    case 200:
                    case 204:
                        const data = await invocation.text(); // XXX: can throw own error
                        const payload = parseJsonPayload(data);
                        return new Request(invocation.headers, payload);
                    case 418:
                        // worker state is either (still)creating or (just)terminating => wait and retry
                        await sleep(100);
                        // noinspection ExceptionCaughtLocallyJS
                        throw new Error(`status-code=${invocation.status}`);
                    default:
                        // unexpected status code => retry
                        // noinspection ExceptionCaughtLocallyJS
                        throw new Error(`status-code=${invocation.status}`);
                }
            }
            catch (e) {
                // unexpected error, retry with small delay
                await sleep(10);
            }
        }
    }
    async work() {
        const request = await this.nextInvocation();
        if (request === null) {
            return;
        }
        const errorListener = (error) => {
            try {
                this
                    .handleError(request, error)
                    .catch((e) => {
                    Errors.logError(e);
                });
            }
            catch (e) {
                Errors.logError(e);
            }
        };
        try {
            // FIXME: could mix up requests and real work in concurrent requests
            process.prependListener('uncaughtException', errorListener);
            process.prependListener('unhandledRejection', errorListener);
            try {
                if (this.unbufferedContent) {
                    await this.handleUnbuffered(request);
                }
                else {
                    const response = await this.handleRequest(request);
                    await this.handleResponse(request, response);
                }
            }
            catch (e) {
                Errors.logError(e);
                await this.handleError(request, e);
            }
        }
        finally {
            // FIXME: could mix up requests and real work in concurrent requests
            process.removeListener('unhandledRejection', errorListener);
            process.removeListener('uncaughtException', errorListener);
        }
    }
    loop() {
        let loop = this.loop.bind(this);
        let terminate = this.terminate;
        this
            .work()
            .then(() => {
            return setImmediate(loop);
        })
            .catch((e) => {
            Errors.logError(e);
            terminate(e);
        });
    }
    async handleUnbuffered(req) {
        let res = this.handler(req.getData(), req);
        if (res instanceof Promise) {
            res.then(resp => this.handleResponseUnbuffered(req, resp));
        }
        else {
            if (typeof (res) === "undefined") {
                // sync function with no result
                throw new Error("Non-async entry point should provide a result. Return a value or use async function instead");
            }
            await this.handleResponseUnbuffered(req, res);
        }
    }
    async handleResponseUnbuffered(req, resp) {
        let headers = {};
        let encodedHeader = false;
        for (let key in resp["multiValueHeaders"]) {
            //HACK node-fetch.Headers() does not respect set-cookie header (CLOUD-56619)
            //TODO consider patching node-fetch
            let headerValues = resp["multiValueHeaders"][key];
            if (key.toLowerCase() === "set-cookie") {
                headers["X-Ycfr-" + key] = [JSON.stringify(headerValues)];
                encodedHeader = true;
            }
            else {
                headers["X-Ycfr-" + key] = headerValues;
            }
        }
        if (encodedHeader) {
            headers["X-Ycf-Encoded-Header"] = "true";
        }
        headers["X-Ycf-Status"] = [resp["statusCode"]];
        const url = `http://${this.runtimeHost}/2018-06-01/runtime/invocation/${req.requestId}/response`;
        let post = {
            method: 'post',
            body: resp.body,
            headers: headers,
            agent: agent
        };
        const reply = await fetch(url, post);
        if (!reply.ok) {
            throw new Error(`${url} returned ${reply.status}`);
        }
    }
    handleRequest(req) {
        return new Promise((resolve, reject) => {
            let res;
            try {
                res = this.handler(req.getData(), req);
            }
            catch (e) {
                reject(e);
                return;
            }
            if (res instanceof Promise) {
                // async functions (just return promise)
                res.then((r) => {
                    resolve(JSON.stringify(r));
                }).catch((e) => reject(e));
                return;
            }
            if (typeof (res) === "undefined") {
                // sync function with no result
                reject(new Error("Non-async entry point should provide a result. Return a value or use async function instead"));
                return;
            }
            try {
                // serialize a result
                resolve(JSON.stringify(res));
            }
            catch (e) {
                reject(e);
            }
        });
    }
    async handleResponse(req, body) {
        const method = "POST";
        const url = `http://${this.runtimeHost}/2018-06-01/runtime/invocation/${req.requestId}/response`;
        const resp = await fetch(url, { method, body, agent });
        if (!resp.ok) {
            throw new Error(`${url} returned ${resp.status}`);
        }
    }
    async handleInitError(err) {
        const method = "POST";
        let url = `http://${this.runtimeHost}/2018-06-01/runtime/init/error`;
        let body = Errors.errorJson(err);
        let resp = await fetch(url, { method, body, agent });
        if (!resp.ok) {
            throw new Error(`${url} returned ${resp.status} during initialization error: ${err.name} ${err.message}`);
        }
    }
    async handleError(req, err) {
        const method = "POST";
        let url = `http://${this.runtimeHost}/2018-06-01/runtime/invocation/${req.requestId}/error`;
        let body = Errors.errorJson(err);
        let resp = await fetch(url, { method, body, agent });
        if (!resp.ok) {
            throw new Error(`${url} returned ${resp.status} during processing error: ${err.name} ${err.message}`);
        }
    }
}
exports.Runtime = Runtime;
