/* 
  This script is triggered by github actions workflow and is responsible for
  publishing documentation updates to contentful cms
 */
import contentful from 'contentful-management';
import fs, { read } from 'fs';
import marked from 'marked';

// init client
const spaceId = 'lfws4sw3zx32';
const envId = 'master';
const client = contentful.createClient({
  accessToken: process.env.CONTENTFUL_API_KEY
});

try {
  publishToCms();
} catch (error) {
  console.log('Error processing request', error);
}

// determines whether to fetch all file content or
// just content from changed paths
async function getFileContent() {
  const changedPaths = getPaths();
  let contentStore;
  if (changedPaths.length === 0) {
    // edits were made to /docs/** 
    contentStore = await readData(changedPaths);
  } else {
    // workflow was manually triggered
    const allFilePaths = getAllPaths();
    contentStore = await readData(allFilePaths);
  }
  console.log('content store: \n', contentStore);
  return contentStore;
}

async function publishToCms() {
  const fileContentStore = await getFileContent();
  const fPaths = Object.keys(fileContentStore);
  const log = {};
  
  // process each file
  for (const path of fPaths) {
    const content = fileContentStore[path];
    const { frontMatter } = parse(content);
    const refId = formatRefId(frontMatter);
    
    const space = await client.getSpace(spaceId);
    const environ = await space.getEnvironment(envId);
    // for update a file must have content
    if (content !== null) {
      if (!hasRequiredFields(frontMatter)) {
        log[path] = 'Front matter must have a valid lang, slug and title field';
        continue;
      }
      const currLocale = getLocale(frontMatter['lang']);
      try {
        // Try fetch the entry
        const entry = await environ.getEntry(refId);
        entry.fields.title[currLocale] = frontMatter['title'];
        entry.fields.author[currLocale] = [process.env.AUTHOR];
        entry.fields.markdown[currLocale] = content;
        entry.fields.source[currLocale] = `https://github.com/${process.env.REPOSITORY}/blob/main/${path}`;
        const updated = await entry.update();
        // TODO: Temp logger
        log[path] = `Entry updated: ${updated.sys.id} on ${updated.sys.updatedAt} by ${updated.sys.updatedBy}`;
      } catch (err) {
        if (err.name === "NotFound") {
          // create a new entry
          const pageEntry = getPageEntry(frontMatter, currLocale, path, content);
          try {
            const entry = await environ.createEntryWithId('page', refId, pageEntry);
            log[path] = `Entry created: ${entry.sys.id} on ${updated.sys.createdAt} by ${updated.sys.createdBy}`;
          } catch (error) {
            log[path] = error;
          }
        }
        if (err.name === "VersionMismatch") {
          // tried to update something whose version is different
          log[path] = err.message;
        }
      }
    }
    // when file has no content a file is likely deleted
    // function will do nothing and update the output log.
    if (content === null) {
      log[path] = 'This file had no content, so the file may have been deleted. No action taken';
      // try {
      //   const res = await environ.deleteEntry(refId);
      //   log[path] = res;
      // } catch (err) {
      //   console.log('Delete error: ', err);
      //   log[path] = err.message;
      // }
    }
  }
  // TODO return this output to Github action
  console.log('===LOG OUTPUT START====\n', log);
  console.log('===LOG OUTPUT END======');
}

// helpers

// checks for required fields
const hasRequiredFields = (frontMatter) => {
  const { slug, lang, title } = frontMatter;
  return (slug !== undefined && slug !== '' ) &&
   (lang !== undefined && lang !== '') &&
    (title !== undefined && title !== '');
};

/**
 * returns a formatted reference id
 * in format of <org>__<repo>__docs__<filename>
 * i.e. slackapi_bolt-js__docs_mydoc.md
 * Note: CMS accepts only _, - or . in ids
*/ 
// function formatRefId(path, locale) {
//   let refId;
//   /**
//    * languages in other files contain a prefix 
//    * e.g. ja_ in docs/_advanced/ja_document_name_here
//    * for non en-US locales
//    * remove the language prefix on the filename
//    * before generating the refId
//    * e.g. docs/ja_document_name_here => docs/document_name_here 
//    * */
//   if(locale !== 'en-US') {
//     console.log('++ the path before is ', path);
//     let tmp = path.split('/');
//     let filename = tmp[tmp.length - 1];
//     let i = filename.indexOf('_');
//     tmp[tmp.length - 1] = filename.slice(i + 1);
//     path = tmp.join('_');
//     console.log('++ the path after is ', path);
//   }
//   refId = `${process.env.REPOSITORY}__${path}`;
//   return refId.replaceAll('/', '_'); 
// }

function formatRefId(frontMatter) {
  let refId;
  /**
   * generates a ref id in the following format:
   * <org>_<repo>_<slug>
   * */
  refId = `${process.env.REPOSITORY}_${frontMatter.slug}`;
  // console.log('ref id is: \n', refId.replaceAll('/', '_'));
  return refId.replaceAll('/', '_'); 
}

// lookup supported locales
const getLocale = (lang) => {
  if (!lang) return;
  const locales =  new Map();
  // TODO when supporting new locales, add an entry here
  locales.set(new Set(['en', 'en-US']), 'en-US');
  locales.set(new Set(['jp', 'ja-jp']), 'ja-JP');

  let currLocale;
  Array.from(locales.keys()).forEach((k) => {
    if (k.has(lang)) {
      currLocale = locales.get(k);  
    }
  });
  return currLocale;
}

// formats a new page entry
const getPageEntry = (frontMatter, currLocale, path, content) => {
  // search
  if (getLocale(frontMatter['lang'])) {
    return {
      fields: {
        title: {
          [currLocale]: frontMatter['title']
        },
        author: {
          [currLocale]: [process.env.AUTHOR]
        },
        source: {
          [currLocale]: `https://github.com/${process.env.REPOSITORY}/blob/main/${path}`,
        },
        markdown: {
          [currLocale]: content
        },
      }
    };
  } else {
    return null;
  }
}
// returns filepaths for all docs files
function getAllPaths() {
  return process.env.ALL_FILES.split(' ')
}

// returns changed filepaths including docs/* only
function getPaths() {
  return process.env.FILES_CHANGED
  .split(' ') 
  .filter(str => /^docs\/.*/.test(str)); 
}

// accepts an array of paths and returns an object where
// key is filepath and value is the associated file data
async function readData(fPaths) {
  let fileData = {};
  for (const path of fPaths) {
    try {
      let data = await fs.promises.readFile(path, 'utf8');
      fileData[path] = data;
    } catch (err) {
      fileData[path] = null;
    }
  }
  return fileData;
}

// returns obj with front matter + page content separate
const parse = (data) => {
  const lexed = marked.lexer(data);
  const frontMatter = {};
  if (hasFrontMatter(lexed)) {
    let split = lexed[1]['raw'].split('\n');
    for (const entry of split) {
      let [key, value] = entry.split(':');
      frontMatter[key] = value.trim();
    }
  }
  const content = lexed.filter((val, i) => i !== 0 && i !== 1 && i !== 2); 
  return {
    frontMatter,
    content
  }
}

// utility object with lexed types data
const TYPES = Object.freeze({
  hr: "hr",
  space: "space",
  code: "code",
  paragraph: "paragraph"
});

// returns true if the document has horizontal rule delineated front matter
const hasFrontMatter = (lexed) => {
  return ((lexed)[0] && lexed[2] && lexed[0]["type"] === TYPES.hr && lexed[2]["type"] === TYPES.hr);
}


/* 

TODO
- can create a new Page ✅
- can delete an existing Page ✅
- can update an existing Page ✅
- add validation of front matter ✅
- Add simple activity logging ✅
- Make activity logging accessible to other github actions 
- 👀 using slug from front-matter for unique identifier ✅ 
  - when a slug is updated?? (i.e new ref ID) 
- can pull locale field from the front-matter ✅
- can add both english and japanese example at the same time ✅
- can create, delete, update i.e. handle a JP language Page 
- can update Author(s) field with the full list of authors
- Includes a tag field with the repo ?? 
- Allow the 

Docs
- All docs are required to have frontmatter: at least lang, title, slug (must be unique)
- Slugs
  - Slugs should use - not _ e.g. listening-messages
  - Slugs must be unique (excepting localized versions. These must always match in order
    for articles in other languages to be associated properly). 
  - Once a slug has been established, it should not be updated. Updating a slug will break links
  - Slugs should also serve as the unique reference for the entry
- Making a change
  - Changing the name of a article, - update the title field (should match the filename)

Migration requirements
Handling failures
- If update or creation or deletion fails, check the log

*/