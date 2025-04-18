import busboy from "busboy";
// tsc gets confused in some cases of event type narrowing if just Readable is imported
import stream from "node:stream";

// returned when a simple name/value field is found in the multipart content
export type FieldEvent = {
    eventType: "field";

    fieldName: string;
    fieldValue: string;

} & busboy.FieldInfo;

// returned when a file is found in the multipart content
export type FileEvent = {
    eventType: "file";

    fieldName: string;

    // custom busboy stream - may have `truncated`, has `bytesRead` and may emit `limit` event
    fileStream: stream.Readable & { truncated?: boolean };

} & busboy.FileInfo;

// returned when one of the parts, files or fields limits has exceeded (file size limit is not included - is emitted directly in the file stream)
export type LimitEvent = {
    eventType: "limit";

    limitName: "parts" | "files" | "fields";
};

export type BusboyAsyncEvent = FieldEvent|FileEvent|LimitEvent;

export class BusboyAsync {
        private bb: busboy.Busboy;

        constructor (busboyConfig: busboy.BusboyConfig) 
        {
            this.bb = busboy(busboyConfig);
        }

        async* busboyEvents() : AsyncGenerator<FieldEvent|FileEvent|LimitEvent>
        {
            let bbEvents = new Array<FieldEvent|FileEvent|LimitEvent>();

            let bbEnd: boolean = false;

            this.bb.on("file", (fieldName: string, fileStream: stream.Readable & { truncated?: boolean }, fileInfo: busboy.FileInfo) => {
                bbEvents.push({
                    eventType: "file",
                    fieldName: fieldName,
                    filename: fileInfo.filename,
                    encoding: fileInfo.encoding,
                    mimeType: fileInfo.mimeType,
                    fileStream: fileStream
                });
            });

            this.bb.on("field", (fieldName: string, fieldValue: string, fieldInfo: busboy.FieldInfo) => {
                bbEvents.push({
                    eventType: "field",
                    fieldName: fieldName,
                    fieldValue: fieldValue,
                    encoding: fieldInfo.encoding,
                    mimeType: fieldInfo.mimeType,
                    nameTruncated: fieldInfo.nameTruncated,
                    valueTruncated: fieldInfo.valueTruncated
                });
            });

            this.bb.on("partsLimit",  () => {
                bbEvents.push({
                    eventType: "limit",
                    limitName: "parts"
                });
            });

            this.bb.on("filesLimit",  () => {
                bbEvents.push({
                    eventType: "limit",
                    limitName: "files"
                });
            });

            this.bb.on("fieldsLimit",  () => {
                bbEvents.push({
                    eventType: "limit",
                    limitName: "fields"
                });
            });

            this.bb.on("close", () => {
                bbEnd = true;
            });

            while(!bbEnd)
                // yield the next event if there is one, and otherwise allow streams to pump more data
                if(bbEvents.length == 0)
                    await new Promise<void>((io_done) => {setImmediate(() => {io_done();});});
                else
                    yield bbEvents.shift() as FileEvent|FieldEvent|LimitEvent;
        }

        feedBusboy(inStream: stream.Readable) : Promise<void>
        {
            // need to keep pumping data into busboy until the entire request body is consumed
            return new Promise((bbDone, bbError) => {
                setImmediate(async () => {
    feedBusboy(inStream: stream.Readable) : Promise<void|Error>
    {
        // need to keep pumping data into busboy in background until the entire request body is consumed
        return new Promise<void|Error>((bbDone: () => void, bbError: (reason: any) => void) : void => {
            setImmediate((bbDone: () => void, bbError: (reason: any) => void) : void => {
                (async (bbDone: () => void, bbError: (reason: any) => void) => {
                    try {
                        // required to make Readable.readableFlowing false (is null before this)
                        inStream.pause();

                        let streamError: Error|undefined = undefined;

                        inStream.on("error", (error: Error) => {
                            streamError = error;
                            inStream.destroy();
                            this.bb.destroy(error);
                        });

                        this.bb.on("error", (error: Error) => {
                            streamError = error;
                            this.bb.destroy();
                            inStream.destroy(error);
                        });

                        // busboy's buffer is full - need to allow downstream components to drain it
                        let needDrain: boolean = false;

                        // in-stream buffer is empty - need to read more from the request
                        let needRead: boolean = false;

                        // pump all data from the in-stream into busboy, pausing to read more or to process what we read
                        while(inStream.readable && this.bb.writable) {
                            if(streamError)
                                throw streamError;

                            if(!needDrain) {
                                let data: Buffer|null = inStream.read();

                                // may return intermittent null values
                                if(data == null)
                                    needRead = true;
                                else {
                                    if(!this.bb.writable)
                                        throw streamError || new Error("busboy stream is not writable");

                                    needDrain = !this.bb.write(data);
                                    needRead = false;
                                }
                            }

                            if(needRead || needDrain) {
                                // allows stream I/O to read/write both streams behind the scenes (process.nextTick won't work)
                                await new Promise<void>((io_done) => {setImmediate(() => {io_done();});});

                                // check if the yielding above pushed some data out of the bb stream
                                if(needDrain)
                                    needDrain = this.bb.writableNeedDrain;
                            }

                            if(inStream.readableEnded && !needDrain) {
                                if(!this.bb.writable)
                                    throw streamError || new Error("busboy stream is not writable");

                                this.bb.end();
                                // without this the busboy stream will not be finalized until it is destroyed later, when the scope of the outer method ends
                                await new Promise<void>((io_done) => {setImmediate(() => {io_done();});});
                                break;
                            }
                        }

                        if(streamError)
                            throw streamError;

                        bbDone();
                    }
                    catch (error) {
                        //
                        // The inner promise is only used as a convenience, so we can
                        // use `await` inside. Handle it here, so it can be discarded,
                        // and reject the outer promise that is returned to the caller.
                        //
                        bbError(error);
                    }
                })(bbDone, bbError);
            }, bbDone, bbError)
        })
        //
        // The returned promise will not be await'ed immediately after
        // it is returned, which will likely cause an unhandled promise
        // rejection exception because of some earlier `await` for an
        // an unrelated promise (i.e. a promise must be handled within
        // a single event loop iteration). So, we have to handle this
        // promise here, which requires the `await` for this promise
        // to check if the returned value is an `Error` instance and
        // rethrow if it is.
        //
        .catch((error?: any) : Promise<void|Error> => {return Promise.resolve(error != undefined ? error : new Error("Unknown error in feedBusboy"));});
    }
}
