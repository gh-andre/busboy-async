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

            this.bb.on("finish", () => {
                bbEnd = true;
            });

            while(!bbEnd)
                // yield the next event if there is one, and otherwise allow streams to pump more data
                if(bbEvents.length == 0)
                    await new Promise<void>((io_done) => {setImmediate(() => {io_done();});});
                else
                    yield bbEvents.shift() as FileEvent|FieldEvent|LimitEvent;
        }

        feedBusboy(inStream: stream.Readable) : Promise<void|Error>
        {
            return new Promise<void|Error>((bbDone: () => void, bbError: (reason: any) => void) : void => {
                inStream
                    .on("error", (error: Error) => {
                        bbError(error);

                        // if streams are not destroyed, Readable.pipe stops pumping data and "finish" will not be emitted
                        if(!inStream.destroyed)
                            inStream.destroy();

                        if(!this.bb.destroyed)
                            this.bb.destroy(error);
                    })
                    .on("finish", () => {
                        bbDone();
                    });

                inStream.pipe(this.bb)
                    .on("error", (error: Error) => {
                        bbError(error);

                        if(!this.bb.destroyed)
                            this.bb.destroy();

                        if(!inStream.destroyed)
                            inStream.destroy(error);
                    })
                    .on("finish", () => {
                        bbDone();
                    });

                inStream.resume();
            })
            //
            // The returned promise will not be await'ed immediately after
            // it is returned, which will likely cause an unhandled promise
            // rejection exception if there is some intermediate `await` for
            // an unrelated promise, such as a file read (i.e. a promise must
            // be handled within a single event loop iteration). In most cases
            // this error will be the same as is the one that ended the data
            // pump above, but for debugging purposes callers may inspect the
            // awaited value of this promise to check if it's something else.
            //
            .catch((error?: any) : any => {
                return Promise.resolve(!error ? new Error("Unknown error in feedBusboy") : error);
            });
        }
}
