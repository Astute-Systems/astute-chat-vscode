/** Kept apart from contentGuard.ts so the webview bundle does not pull in Node's path module. */
export const DUMMY_FILE_RULE =
  "Write only real, complete code. Never create placeholder, stub, dummy or empty files. Libraries, object files and other binaries can only come from running the compiler or build tool, never from write_file. Only say a task is finished if the tool results show that it worked.";
