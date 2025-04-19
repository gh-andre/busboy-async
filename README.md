# busboy-async

An asynchronous generator for busboy events.

# Description

`busboy` is a Node.js module for parsing multi-part HTML form data,
which is implemented to communicate form values back to the caller
via callbacks. `busboy-async` is based on `busboy` and provides an
asynchronous generator returning form values in the order of their
appearance within the form submission request.

One of the advantages of using an asynchronous generator vs. more
traditional callbacks is that there is no need to use `Readable.pipe`
or similar methods to obtain form values, including file streams,
so file streams may be processed outside of callbacks, and may be
intermixed with validation and other request processing code in a
more maintainable `async`/`await` fashion.

# Example usage

HTML form controls are submitted in their DOM order, so arranging
form controls such that the file input is located last within
a form allows one to construct a request argument object, which
may be validated via `Joi` or similar packages, and then process
the data stream in the backend code as a regular form submission
or an API call would be process.

This example uses Express just for exposition. `busboy-async`
depends only  on `busboy` and Node.js streams.

```TypeScript
import { BusboyAsync, BusboyAsyncEvent } from "busboy-async";

async function on_image_put(req: express.Request,
                            res: express.Response,
                            next: express.NextFunction) : Promise<void>
{
    try {
        res.set("Content-Type", "application/json");

        let reqArgs: Record<string, any> = {};

        let imageContentType: string|undefined = undefined;

        // busboy augments standard readables with additional data members
        let imageStream: stream.Readable & {truncated?: boolean}|undefined = undefined;

        let busboyAsync = new BusboyAsync({headers: req.headers});

        // returns a promse that resolves when all events generated by busboy are returned (not needed in most cases)
        busboyAsync.feedBusboy(req);

        // a variable is used, so the loop can be interrupted to process file streams
        let busboyEvents: AsyncGenerator<BusboyAsyncEvent> = busboyAsync.busboyEvents();

        try {
            // loop until we encounter the file stream for a file input
            for await (let bbEvent of busboyEvents) {
                if(bbEvent.eventType == "field") {
                    if(bbEvent.fieldName == "csrf")
                        reqArgs.csrf = bbEvent.fieldValue;
                    else if(bbEvent.fieldName == "size")
                        reqArgs.size = bbEvent.fieldValue;
                }
                else if(bbEvent.eventType == "file") {
                    if(bbEvent.fieldName == "image") {
                        // file input field name
                        reqArgs.name = bbEvent.fieldName;
                        // original file name, if present (use with care - may be malicious)
                        reqArgs.filename = bbEvent.filename;

                        imageContentType = bbEvent.mimeType;
                        imageStream = bbEvent.fileStream;

                        // break out to process the request and finalize reading the rest of the args after
                        break;
                    }
                }
                else if(bbEvent.eventType == "limit") {
                    res.status(400).json({status: "error", message: `Too many ${bbEvent.limitName}`});
                    return;
                }
            }
        }
        catch (error) {
            // the error originates in user data - hence the bad-request error
            next(new httpError.BadRequest());
            return;
        }

        if(imageStream == undefined) {
            res.status(400).json({status: "error", message: "Missing image data"});
            return;
        }

        // validate form fields as usual (the file field may be checked via Joi.any())
        let reqQuery = joiImagePut.validate(reqArgs, joiValidateOptions);

        if(reqQuery.error) {
            res.status(400).json({status: "error", message: reqQuery.error.message});
            return;
        }

        validateCsrf(reqQuery.value.csrf);

        //
        // Upload size may not be required and may be computed while
        // the data stream is being processed, but for some uses this
        // would require saving it to the file first. Passing data
        // size explicitly allows one to use this mechanism to save
        // data to AWS S3, for example, and without using intermediate
        // local storage.
        //
        const imageSize: number = reqQuery.value.size;

        //
        // imageStream is a custom busboy stream that will have an
        // optional `truncated` field if the file limit is exceeded,
        // a `bytesRead` field to track how much data was read, and
        // will emit a `limit` event if the file is larger than the
        // allowed limit and has been truncated.
        //
        processImageStream(imageStream, imageContentType, imageSize, reqQuery.value.filename);

        try {
            // must continue the same loop to consume all events (e.g. exceeded limits or more files)
            for await (let bbEvent of busboyEvents)
                handleBusboyAsyncEvent(bbEvent);
        }
        catch (error) {
            // if not last image, MUST rollback image processing above
            next(new httpError.BadRequest());
            return;
        }

        res.json({status: "success"});
    }
    catch (err) {
        next(new httpError.InternalServerError());
        return;
    }
}

```
If more than one file is submitted in form data, additional files
must be consumed completely before additional fields will be
returned by the generator.

The promise returned from `busboyAsync.feedBusboy` is resolved at
the end of the form data stream and normally there is no need to
await for it because this error will be thrown from within the
asynchronous generator loop, as shown in the example above. The
returned promise may be used to examine this error for debugging
purposes, as shown below.

```TypeScript

    let bbResult: void|Error = await busboyDone;

    if(bbResult instanceof Error)
        throw bbResult;
```

An optional error handler may be passed into `busboyAsync.feedBusboy`
as shown below. It is important to realize that returning a rejected
promise from this handler or throwing an error will result in an
unhandled promise rejection, which will terminate the Node.js process
by default.

```TypeScript
    busboyAsync.feedBusboy(req, (error: any) : any|Promise<any> => {
        logError(error);
    });
```

The error handler will be called in the asynchronous context of
the form stream data pump and should not be used to call any request
processing functions, such as Express' `next()` function with the
request processing status code.
