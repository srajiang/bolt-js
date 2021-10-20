/* 
  This script is triggered by github actions workflow and is responsible for
  publishing documentation updates to contentful cms
 */
import contentful from 'contentful-management';
import fs from 'fs';
import yaml from 'js-yaml';
import marked from 'marked';

// init client
const spaceId = 'lfws4sw3zx32';
const envId = 'master';
const client = contentful.createClient({
  accessToken: process.env.CONTENTFUL_API_KEY
});

// returns filepaths for all docs files
const getAllPaths = () => {
  return process.env.ALL_FILES.split(' ')
}

// returns changed filepaths including docs/* only
const getPaths = (filesChanged) => {
  return filesChanged
  .split(' ') 
  .filter(str => /^docs\/.*/.test(str));
  // TODO: Modify based on the path provided by git actions
}

// accepts an array of paths and returns an object where
// key is filepath and value is the associated file data
const readData = async (fPaths) => {
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

// determines whether to fetch all file content or
// just content from changed paths
const getFileContent = async () => {
  const changedPaths = getPaths(process.env.FILES_CHANGED);
  let contentStore;
  if (changedPaths.length > 0) {
    // edits were made to /docs/** 
    contentStore = await readData(changedPaths);
  } else {
    // workflow was manually triggered
    const allFilePaths = getAllPaths();
    contentStore = await readData(allFilePaths);
  }
  return contentStore;
}

// returns true if the document has horizontal rule delineated front matter
const hasFrontMatter = (lexed) => {
  return ((lexed)[0] && lexed[2] && lexed[0]["type"] === TYPES.hr && (lexed[2]["type"] === TYPES.hr || lexed[3]["type"] === TYPES.hr));
}

// checks for required fields and returns missing
const getMissingFields = (frontMatter) => {
  let required = ['slug', 'title', 'lang'] // TODO: Add uuid
  return required.filter(field => {
    return (frontMatter[field] === undefined || frontMatter[field] === '');
  })
};

// returns the repository source
const getSourceTag = () => {
  return process.env.REPOSITORY.split('/')[1];
}

// get collection entry
const getCollectionEntry = (entry, order) => {
  return {
    fields: {
      order: order,
      title: entry
    },
    metadata: {
      tags: [{
        sys: {
          type: 'Link',
          linkType: 'Tag',
          id: getSourceTag(),
        }
      }]
    }
  }
}

const updateCollectionEntryAndPublish = async (entry, order, collectionContent) => {
  entry.fields.order = order;
  entry.fields.title = collectionContent;
  const updated = await entry.update();
  await updated.publish();
}

// TODO: update page manifest
const publishCollections = async () => {
  console.log('inside publish collections');
  // Get document, or throw exception on error
  let config = {};
  try {
    config = yaml.load(fs.readFileSync('docs/config.yml', 'utf8')); 
  } catch (e) {
    console.log(e);
  }
  const log = {};
  const space = await client.getSpace(spaceId);
  const environ = await space.getEnvironment(envId);
  let collectId, order;
  // try to update first otherwise create collection entry
  try {
    const collections = Object.keys(config['collections']);
    
    for (let i = 0; i < collections.length; i++) {
      order = i;
      collectId = collections[i];
      console.log('processing', collectId);
      const collectEntry = getCollectionEntry(collectId, order);
      const refId = formatRefId(collections[i]);
      const entry = await environ.getEntry(refId);
      let updated = await updateCollectionEntryAndPublish(entry, order, collectEntry);
      log[collectId] = `Collection entry updated: ${updated.sys.id}`;
    }
  } catch (err) {
    if (err.name === "NotFound") {
      console.log('creating new', collectId);
      const collectEntry = getCollectionEntry(collectId, order);
      const entry = await environ.createEntryWithId('collection', refId, collectEntry);
      const published = await entry.publish();
      log[collectId] = `Collection entry created: ${published.sys.id}`;
    } else {
      log[collectId] = err;
    }
  }
}

// generates a reference id that corresponds to Contentful entry id
const formatRefId = (id) => {
  let refId;
  /**
   * generates a ref id in the following format:
   * <org>_<repo>_<slug>
   * */
  refId = `${process.env.REPOSITORY}_${id}`;
  return refId.replaceAll('/', '_'); 
}

// lookup supported locales
const getLocale = (lang) => {
  if (!lang) return;
  const locales =  new Map();
  // To support new locales, add an entry here
  locales.set(new Set(['en', 'en-US', 'en-us']), 'en-US');
  locales.set(new Set(['jp', 'ja-JP', 'ja-jp']), 'ja-JP');

  let currLocale;
  Array.from(locales.keys()).forEach((k) => {
    if (k.has(lang)) {
      currLocale = locales.get(k);  
    }
  });
  return currLocale;
}

// formats a new page entry
const getPageEntry = (path, frontMatter, body) => {
  let currLocale = getLocale(frontMatter['lang']);
  // must have a valid locale
  if (currLocale) {
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
          [currLocale]: body
        },
        slug: {
          [currLocale]: frontMatter['slug']
        },
        uuid: {
          [currLocale]: frontMatter['uuid']
        },
        order: {
          [currLocale]: frontMatter['order']
        }
      },
      metadata: {
        tags: [{
          sys: {
            type: 'Link',
            linkType: 'Tag',
            id: getSourceTag(),
          }
        }]
      }
    };
  } else {
    return null;
  }
}

// returns obj with front matter + page body separate
const parse = (data) => {
  const lexed = marked.lexer(data);
  const frontMatter = {};
  // store front matter
  if (hasFrontMatter(lexed)) {
    let split = lexed[1]['raw'].split('\n');
    for (const entry of split) {
      let [key, value] = entry.split(':');
      frontMatter[key] = value.trim();
    }
  }
  // strip out front matter from rest of body
  const match = /---.+---/gs.exec(data);
  const body = match ? data.slice(match.index + match[0].length) : null;
  return {
    frontMatter,
    body,
    tokens: lexed, // not used currently
  }
}

// utility object with lexed types data
const TYPES = Object.freeze({
  hr: "hr",
  space: "space",
  code: "code",
  paragraph: "paragraph"
});

// validate required fields
const validateFrontMatter = (frontMatter) => {
  // all required fields exist
  let missing = getMissingFields(frontMatter);
  if (missing.length > 0) {
    throw new Error(`Missing required field(s) ${missing}`);
  }
  // slug contains valid characters
  if (frontMatter['slug'].match(/[_/*.!]+/) !== null) {
    throw new Error(`Slug contains invalid special character. Slugs should contain hyphens only, e.g. example-doc-name.md`);
  }
}

// checks that a uuid exists and is being added
const validateUUID = (entry, frontMatter) => {
  let localizedUUID = entry.fields.uuid ? entry.fields.uuid[currLocale]: null;
  // provided uuid does not matching existing uuid field in the entry
  if (localizedUUID && localizedUUID !== frontMatter['uuid']) {
   throw new Error('Attempted to update entry whose uuid does not match provided uuid') 
  } 
  // no uuid in existing entry and no uuid 
  // TODO: Enable these lines
  // if (!localizedUUID && (!frontMatter['uuid'] || !frontMatter['uuid' === ''])) {
  //   throw new Error('Please provide a uuid in the front matter')
  // }
}

const updatePageEntryAndPublish = async (entry, frontMatter, body, path) => {
  if (!entry || !frontMatter) {
    throw new Error ('Missing entry or frontmatter');
  }
  let currLocale = getLocale(frontMatter['lang']);
  entry.fields.title[currLocale] = frontMatter['title'];
  entry.fields.author[currLocale] = [process.env.AUTHOR];
  entry.fields.markdown[currLocale] = body;
  entry.fields.source[currLocale] = `https://github.com/${process.env.REPOSITORY}/blob/main/${path}`;
  // TODO: Remove this once order is handled via manifest
  if (entry.fields.order) {
    entry.fields.order[currLocale] = frontMatter['order'];
  } else {
    entry.fields.order = {
      [currLocale]: frontMatter['order']
    }
  }
  if (entry.fields.slug) {
    entry.fields.slug[currLocale] = frontMatter['slug'];
  } else {
    entry.fields.slug = {
      [currLocale]: frontMatter['slug']
    };
  }
  // TODO: Update once uuid is mandatory
  // entry.fields.uuid[currLocale] = frontMatter['uuid']; 
  let updated = await entry.update();
  await updated.publish();
}

const createPageEntryAndPublish = async (path, frontMatter, body, refId, environ) => {
  const pageEntry = getPageEntry(path, frontMatter, body);
  const entry = await environ.createEntryWithId('page', refId, pageEntry);
  await entry.publish();
  return entry;
}

// primary function to create, update, entries
const publishPages = async () => {
  const fileContentStore = await getFileContent();
  const fPaths = Object.keys(fileContentStore);
  const log = {};
  
  // process each file
  for (const path of fPaths) {
    const content = fileContentStore[path];
    const { frontMatter, body } = parse(content);
    const refId = formatRefId(frontMatter['slug']);
    const space = await client.getSpace(spaceId);
    const environ = await space.getEnvironment(envId);
    if (content !== null) {
      try {
        // updates existing entry
        validateFrontMatter(frontMatter);
        const entry = await environ.getEntry(refId);
        validateUUID(entry, frontMatter);
        await updatePageEntryAndPublish(entry, frontMatter, body, path);
        log[path] = `Page entry updated: ${entry.sys.id}`;
      } catch (err) {
        if (err.name === "NotFound") {
          // create new entry
          try {
            await createPageEntryAndPublish(path, frontMatter, body, refId, environ);
          } catch (error) {
            log[path] = error.message;
          }
        } else {
          log[path] = err.message;
        }
      }
    }
    // when file has no content a file is likely deleted
    // function will do nothing and update the output log.
    if (content === null) {
      log[path] = 'This file had no content, so the file may have been deleted. No action taken';
    }
  }
  // TODO return this output to Github action
  console.log('===LOG OUTPUT START====\n', log);
  console.log('===LOG OUTPUT END======');
}

// adds new tags if necessary
const updateTags = async () => {
  const source = getSourceTag();
  const space = await client.getSpace(spaceId);
  const environ = await space.getEnvironment(envId);
  const tags = await environ.getTags();
  let hasTag = false;
  for (let tag of tags.items) {
    if (tag.sys.id === source) {
      hasTag = true;
    }
  }
  if (!hasTag) {
    environ.createTag(source, source);
  }
}

const publish = async () => {
  try {
    await publishCollections();
    // await updateTags();
    // await publishPages();
  } catch (error) {
    console.log('Error processing request', error);
  }
}

publish();
/* 

TODO
- can create a new Page ✅
- can delete an existing Page ✅
- can update an existing Page ✅
- add validation of front matter ✅
- Add simple activity logging ✅
- 👀 using slug from front-matter for unique identifier ✅ 
- can pull locale field from the front-matter ✅
- can add both english and japanese example at the same time ✅
- can create, update i.e. handle a JP language Page ✅
- can update Author(s) field with the full list of authors for a file 💡
- Includes a tag field with the repo ✅
- More robust front matter handling ✅ 
- Could handle asset upload to contentful? 
- Make logging better with summary stats for easy review and coded errors
- Add a testing suite for this function
- Make activity logging accessible to other github actions

Docs
- All docs are required to have frontmatter: at least lang, title, slug (must be unique) in the proper format ✅
- Order is not required ❗
- Slugs
  - Add validation on slugs - Slugs should use - not _ e.g. listening-messages ❗
  - Slugs must be unique (excepting localized versions. These must always match in order) 
    for articles in other languages to be associated properly). 
  - Once a slug has been established, it should not be updated. Updating a slug will break links
  - Slugs should also serve as the unique reference for the entry 
- Making a change
  - Changing the name of a article, - update the title field (should match the filename)
  
- Notes 
    - Anytime there are new documentations to add in different supported languages, the supported languages need to be updated
- Publishing
  - yml
  - get all files step should accept a path in the config that contains the path to search within
  - 
*/