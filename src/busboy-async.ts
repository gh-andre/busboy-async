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
                    try {
                        // required to make Readable.readableFlowing false (is null before this)
                        inStream.pause();

                        // busboy's buffer is full - need to allow downstream components to drain it
                        let needDrain: boolean = false;

                        // in-stream buffer is empty - need to read more from the request
                        let needRead: boolean = false;

                        // pump all data from the in-stream into busboy, pausing to read more or to process what we read
                        while(inStream.readable) {
                            if(!needDrain) {
                                let data: Buffer|null = inStream.read();

                                // may return intermittent null values
                                if(data == null)
                                    needRead = true;
                                else {
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
                                this.bb.end();
                                // without this the busboy stream will not be finalized until it is destroyed later, when the scope of the outer method ends
                                await new Promise<void>((io_done) => {setImmediate(() => {io_done();});});
                                break;
                            }
                        }

                        bbDone(undefined);
                    }
                    catch (error) {
                        bbError(error);
                    }
                });
            });
        }
}
