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

        private bbError?: Error;

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

            while(!bbEnd && !this.bbError) {
                // yield the next event if there is one, and otherwise allow streams to pump more data
                if(bbEvents.length == 0)
                    await new Promise<void>((io_done) => {setImmediate(() => {io_done();});});
                else
                    yield bbEvents.shift() as FileEvent|FieldEvent|LimitEvent;
            }

            // throw the original error, which contains the call stack captured in the data pump loop
            if(this.bbError)
                throw this.bbError;
        }

        feedBusboy(inStream: stream.Readable, catchHandler?: (error: any) => any|Promise<any>) : Promise<void|Error>
        {
            let bbDataFeed: Promise<void|Error> = new Promise<void|Error>((bbDone: () => void, bbError: (reason: any) => void) : void => {
                inStream
                    .on("error", (error: Error) => {
                        //
                        // There appears to be a design flaw in busboy in which an error
                        // in the form data stream will not propagate into the secondary
                        // file stream created by busboy when encountering file data,
                        // which results in the disconnected primary pipe that will never
                        // supply more data and the secondary file stream waiting for the
                        // data forever. This can be reproduced by closing the browser
                        // after the file even was emitted by the primary parsing stream.
                        // As a workaround destroy explicitly the busboy stream, which
                        // propagates to the file stream, and terminates the file upload.
                        //
                        if(!this.bb.destroyed)
                            this.bb.destroy(error);
                    });

                this.bb
                    .on("error", (error: Error) => {
                        bbError(error);
                    })
                    .on("finish", () => {
                        bbDone();
                    });

                inStream.pipe(this.bb);
            });

            //
            // The returned promise may not be await'ed immediately after
            // it's returned, which may cause an unhandled promise rejection
            // if there's some intermediate `await` for an unrelated promise,
            // such as a file read (i.e. if a promise is not handled within
            // a single event loop iteration it is considered as unhandled
            // rejection). In most cases the error captured here will be the
            // same as the one that ended the data pump above, but for
            // debugging purposes callers that didn't provide their own
            // catch handler may inspect the awaited value of this promise
            // to see if it's something else.
            //
            if(catchHandler != undefined)
                bbDataFeed.catch((error: any) : any|Promise<any> => {this.bbError = error; catchHandler(error);});
            else
                bbDataFeed.catch((error: any) : any|Promise<any> => {this.bbError = error; return Promise.resolve(error);});

            return bbDataFeed;
        }
}
