/** High-level kind of a finding. */
export enum XmlCategory {
  Format = 'FORMAT',
  Xml = 'XML',
  Script = 'SCRIPT',
  Style = 'STYLE',
  External = 'EXTERNAL',
  Link = 'LINK',
  Form = 'FORM',
  Navigation = 'NAVIGATION',
  Embedded = 'EMBEDDED',
  Svg = 'SVG',
  Xslt = 'XSLT',
  Server = 'SERVER',
  Mht = 'MHT',
  Metadata = 'METADATA',
  Limit = 'LIMIT',
  Processing = 'PROCESSING',
}

/** Exact variant of a finding. Some details appear under more than one category. */
export enum XmlDetail {
  // FORMAT
  Unrecognized = 'UNRECOGNIZED',
  Unreadable = 'UNREADABLE',
  Hta = 'HTA',
  Office = 'OFFICE',
  Ebcdic = 'EBCDIC',
  Utf7 = 'UTF7',
  AmbiguousComment = 'AMBIGUOUS_COMMENT',
  AmbiguousInstruction = 'AMBIGUOUS_INSTRUCTION',
  ConditionalComment = 'CONDITIONAL_COMMENT',
  // XML
  Doctype = 'DOCTYPE',
  InternalSubset = 'INTERNAL_SUBSET',
  ExternalDtd = 'EXTERNAL_DTD',
  ExternalEntity = 'EXTERNAL_ENTITY',
  XInclude = 'XINCLUDE',
  Malformed = 'MALFORMED',
  Encoding = 'ENCODING',
  SchemaLocation = 'SCHEMA_LOCATION',
  // SCRIPT
  Element = 'ELEMENT',
  EventHandler = 'EVENT_HANDLER',
  Url = 'URL',
  Animation = 'ANIMATION',
  Macro = 'MACRO',
  // STYLE
  Expression = 'EXPRESSION',
  Binding = 'BINDING',
  Import = 'IMPORT',
  RemoteUrl = 'REMOTE_URL',
  Escaped = 'ESCAPED',
  MarkupInStyle = 'MARKUP_IN_STYLE',
  // EXTERNAL
  Resource = 'RESOURCE',
  Stylesheet = 'STYLESHEET',
  Prefetch = 'PREFETCH',
  LocalFile = 'LOCAL_FILE',
  // LINK
  Safe = 'SAFE',
  FileUrl = 'FILE_URL',
  NetworkPath = 'NETWORK_PATH',
  DataUrl = 'DATA_URL',
  OtherScheme = 'OTHER_SCHEME',
  Credentials = 'CREDENTIALS',
  IpHost = 'IP_HOST',
  LookalikeHost = 'LOOKALIKE_HOST',
  EncodedHost = 'ENCODED_HOST',
  TextMismatch = 'TEXT_MISMATCH',
  Relative = 'RELATIVE',
  PathTrick = 'PATH_TRICK',
  // FORM
  Submit = 'SUBMIT',
  Password = 'PASSWORD',
  // NAVIGATION
  Refresh = 'REFRESH',
  RelativeRefresh = 'RELATIVE_REFRESH',
  Base = 'BASE',
  RelativeBase = 'RELATIVE_BASE',
  SetCookie = 'SET_COOKIE',
  // EMBEDDED
  Iframe = 'IFRAME',
  Frame = 'FRAME',
  Object = 'OBJECT',
  Embed = 'EMBED',
  Applet = 'APPLET',
  NoPlugin = 'NO_PLUGIN',
  TypeMismatch = 'TYPE_MISMATCH',
  PluginPassed = 'PLUGIN_PASSED',
  PluginScrubbed = 'PLUGIN_SCRUBBED',
  PluginFailed = 'PLUGIN_FAILED',
  PluginRemoved = 'PLUGIN_REMOVED',
  // SVG
  ForeignObject = 'FOREIGN_OBJECT',
  UseExternal = 'USE_EXTERNAL',
  UseAmplification = 'USE_AMPLIFICATION',
  // XSLT
  Script = 'SCRIPT',
  ExtensionFunction = 'EXTENSION_FUNCTION',
  ExtensionElement = 'EXTENSION_ELEMENT',
  Document = 'DOCUMENT',
  Include = 'INCLUDE',
  ResultDocument = 'RESULT_DOCUMENT',
  UnescapedOutput = 'UNESCAPED_OUTPUT',
  Evaluate = 'EVALUATE',
  // SERVER
  Ssi = 'SSI',
  Esi = 'ESI',
  Code = 'CODE',
  // MHT
  HiddenData = 'HIDDEN_DATA',
  // METADATA
  Stripped = 'STRIPPED',
  // LIMIT
  FileSize = 'FILE_SIZE',
  Depth = 'DEPTH',
  TokenSize = 'TOKEN_SIZE',
  EntityDepth = 'ENTITY_DEPTH',
  EntityExpansions = 'ENTITY_EXPANSIONS',
  EntitySize = 'ENTITY_SIZE',
  Parts = 'PARTS',
  DecodedSize = 'DECODED_SIZE',
  NestingDepth = 'NESTING_DEPTH',
  Time = 'TIME',
  // PROCESSING
  MemoryFallback = 'MEMORY_FALLBACK',
  VerificationFailed = 'VERIFICATION_FAILED',
  ContentRemoved = 'CONTENT_REMOVED',
}

export type XmlFindingAction = 'reject' | 'strip' | 'info';

/**
 * A finding as any package of the defuse family reports it. Category and detail are plain strings, since the string
 * enums of two packages never match each other.
 */
export interface DefuseFinding {
  category: string;
  detail: string;
  /** Plain sentence, safe to show the uploader. */
  description: string;
  /** Default action after any caller override. */
  action: 'reject' | 'strip' | 'info';
  /** Where in the file, such as "line 12, <script>". */
  location?: string;
  /** Extra values: the URL, the element, the attribute, counts. */
  data?: Record<string, string | number>;
  /**
   * Set when the finding comes from inside a contained file, such as an image in a data: URL: the file's name, with
   * " > " between nesting levels. `location` then starts with where that file sits.
   */
  attachment?: string;
  /** How much the finding adds to a score, set by the package that made it. */
  weight?: number;
}

/** A finding xml-defuse makes itself. */
export interface XmlFinding extends DefuseFinding {
  category: XmlCategory;
  detail: XmlDetail;
}

export enum XmlRisk {
  None = 'NONE',
  Low = 'LOW',
  Medium = 'MEDIUM',
  High = 'HIGH',
  Critical = 'CRITICAL',
  /** The file could not be inspected: not a format this package reads, or a limit stopped the run. */
  Unknown = 'UNKNOWN',
}

/** The syntax and vocabulary a file was read as. '' when it was not recognized. */
export type XmlFormat = 'html' | 'xhtml' | 'svg' | 'xslt' | 'xml' | 'mht' | 'css' | '';

export interface XmlInspection {
  status: 'clean' | 'strippable' | 'rejected';
  /** 0 to 100, null when risk is UNKNOWN. */
  score: number | null;
  risk: XmlRisk;
  findings: DefuseFinding[];
  format: XmlFormat;
  /** The MIME type of a file in that format. '' when not recognized. */
  mimeType: string;
  /** The character encoding the text was decoded with, such as 'utf-8' or 'windows-1252'. '' when none was. */
  encoding: string;
}

export interface XmlDisarmResult {
  status: 'clean' | 'defused' | 'rejected';
  /** The uploaded file and its score. */
  before: XmlInspection;
  /** The output and its remaining score. Absent when rejected. */
  after?: XmlInspection;
  /** Findings whose content was removed. */
  removed: DefuseFinding[];
}

/** Random-access input. A buffer, a local file and an S3 ranged GetObject all fit. */
export interface ByteSource {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

/** Append-only output. Never seeks. */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Called instead of close() when copying to the sink fails, so a partial output is not taken for a whole one. */
  abort?(error: unknown): Promise<void>;
}

export interface XmlLimits {
  /** Bytes in the upload. Not enforced unless set. */
  fileSize?: number;
  /**
   * Element nesting depth. Default 256 for XML and 4096 for HTML, where unclosed elements stack up. The multipart
   * bodies of an MHT file may nest as deep as XML elements.
   */
  depth?: number;
  /** Characters in one tag, comment, processing instruction, CDATA section or document type declaration. Default 16 Mi. */
  tokenSize?: number;
  /** XML entity references nested inside entity text. Default 16. */
  entityDepth?: number;
  /** XML entity references and attribute defaults expanded in the whole run. Default 100,000. */
  entityExpansions?: number;
  /** Characters of XML entity text and attribute defaults expanded in the whole run. Default 16 Mi. */
  entitySize?: number;
  /** Parts in an MHT file, nested multiparts included. Default 10,000. */
  parts?: number;
  /** Decoded bytes of any one MHT part or data: URL. Default 512 MiB. */
  decodedBytes?: number;
  /**
   * The deepest a file may sit in the upload. The upload is at depth 0 and a file inside it at 1, and files of every
   * format in between count. Not enforced unless set.
   */
  nestingDepth?: number;
  /** Milliseconds for the whole run. Not enforced unless set. */
  timeMs?: number;
}

/** What a contained file plugin learns of the run, with nothing format-specific, so any package of the family can make one. */
export interface PluginContext {
  /** The depth of the file itself: 0 for the upload, 1 for a file inside it, and so on, whatever the formats. */
  depth: number;
  /** When `limits.timeMs` is set, the Date.now() value the whole run must finish by. Nested runs share it. */
  deadline?: number;
}

export interface ContainedFile {
  name?: string;
  /** The MIME type the container declares for the file, such as the media type of a data: URL or an MHT part's Content-Type. */
  declaredType?: string;
  /** From the first bytes. */
  sniffedType?: string;
  /** Decoded size. */
  size: number;
  location: string;
  /** The depth of the file itself: 0 for the upload, 1 for a file inside it, and so on, whatever the formats. */
  depth: number;
  /** Decoded bytes. */
  source: ByteSource;
}

/** What a file plugin did, plus anything it found inside the file. */
export interface ContainedFileResult {
  result: 'scrubbed' | 'passed' | 'removed';
  /** Findings inside the file as it arrived. They go into the report of the file that contains it. */
  findings?: DefuseFinding[];
  /** Findings inside the bytes the plugin kept. They go into the report of the output. */
  outputFindings?: DefuseFinding[];
}

export interface ContainedFilePlugin {
  kind: 'file';
  name: string;
  accepts(file: ContainedFile): boolean | Promise<boolean>;
  /** Writes the bytes to keep. Returning 'removed' drops the file after all. */
  process(file: ContainedFile, sink: ByteSink, context: PluginContext): Promise<'scrubbed' | 'passed' | 'removed' | ContainedFileResult>;
}

export interface XmlActionOverride {
  category: XmlCategory;
  detail?: XmlDetail;
  action: XmlFindingAction;
}

export interface XmlScoreWeight {
  category: XmlCategory;
  detail?: XmlDetail;
  weight: number;
}

/** Lower bound of each band. */
export interface XmlScoreBands {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

export interface XmlOptions {
  /**
   * The file's name, as an upload or the container that holds the file gives it. A name that ends in .hta makes the file
   * FORMAT/HTA, and one that ends in .css reads a file with no markup at the start as a style sheet. xmlPlugin passes the
   * name of each file it gets instead.
   */
  name?: string;
  /** The MIME type the upload declares. `text/css` reads a file with no markup at the start as a style sheet. */
  declaredType?: string;
  limits?: XmlLimits;
  /** Default false. */
  stripMetadata?: boolean;
  actionOverrides?: XmlActionOverride[];
  scoreWeights?: XmlScoreWeight[];
  scoreBands?: XmlScoreBands;
  /** Plugins for whole files inside the file: data: URLs that load a resource, and the parts of an MHT file that are not markup or CSS. */
  filePlugins?: ContainedFilePlugin[];
  /** Directory for temporary files. Defaults to os.tmpdir(). */
  tempDir?: string;
  /**
   * Default 8 MiB. disarmXmlSource keeps its copy of the upload and its output in memory up to this size and in
   * temporary files above it. Each decoded MHT part and data: URL above it goes through a temporary file, and the
   * copies plugins scrubbed share this much memory.
   */
  memoryThreshold?: number;
}

/**
 * A file's format as a package of the family finds it, among the formats that package reads. The family's router asks
 * each package and routes the file by the answers.
 */
export interface FormatDetection {
  /** The format's MIME type, such as text/html. */
  mimeType: string;
  /** The format's usual extension, lowercase and without the dot. */
  extension: string;
  /** Where the format starts in the file: 0, or the offset of its data when other data comes first. */
  offset: number;
  /** Set when the match rests on more than the content, and says what it rests on. */
  heuristic?: string;
}

/** What a detect function may know of a file besides its content. */
export interface DetectOptions {
  /** The file's name, as the upload or the container that holds it gives it. */
  name?: string;
  /** The MIME type the upload or the container declares. */
  declaredType?: string;
  /** The Date.now() value detection must finish by, as `PluginContext.deadline`. */
  deadline?: number;
  /** Folder for temporary files. Defaults to `os.tmpdir()`. */
  tempDir?: string;
  /** Bytes held in memory before a temporary file takes over. */
  memoryThreshold?: number;
}
