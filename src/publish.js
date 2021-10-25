/* 
  This script is triggered by github actions workflow and is responsible for
  publishing documentation updates to contentful cms
 */
import contentful from 'contentful-management';
import fs from 'fs';
import yaml from 'js-yaml';
import marked from 'marked';

const logger = {};
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
// key is filepath and value is the file data
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

// determines whether to fetch all file content or content from changed paths
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

// return true if the document has horizontal rule delineated front matter
const hasFrontMatter = (lexed) => {
  return ((lexed)[0] && lexed[2] && lexed[0]["type"] === TYPES.hr && (lexed[2]["type"] === TYPES.hr || lexed[3]["type"] === TYPES.hr));
}

// checks for required fields and returns missing
const getMissingFields = (frontMatter) => {
  let required = ['slug', 'title', 'lang'];
  return required.filter(field => {
    return (frontMatter[field] === undefined || frontMatter[field] === '');
  })
};

// returns the repository source
const getSourceTag = () => {
  return process.env.REPOSITORY.split('/')[1];
}

// returns formatted list of linked pages to a particular collection
const getPageLinks = (content) => {
  const linkedSlugsArray = content['slugs'] ? content['slugs'] : [];
  return linkedSlugsArray.map(slug => {
    return {
      sys: {
        type: "Link",
        linkType: "Entry",
        id: formatRefId(slug, 'page')
      }
    }
  })
}

// get collection entry
const formatCollection = (order, content) => {
  const pageLinks = getPageLinks(content);
  return {
    fields: {
      title: content['title'],
      // TODO: CMS field to accept symbols not strings
      order: {
        "en-US": order.toString(),
      },
      pages: {
        "en-US": pageLinks,
      },
      url: {
        "en-US": content['url'] ?? ""
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
  }
}

const updateCollectionAndPublish = async (entry, order, collectionContent) => {
  entry.fields.title = collectionContent['title'];
  entry.fields.url = {
    "en-US": collectionContent['url'] ?? ""
  }
  entry.fields.order = {
    "en-US": order.toString(),
  };
  entry.fields.pages = {
    "en-US": getPageLinks(collectionContent),
  }
  const updated = await entry.update();
  await updated.publish();
}

// ensures each file has a title field, and a slugs field with at least one entry
const validateConfig = (config) => {
    const entries = Object.entries(config);
    for (let obj of entries) {
      // each entry must have at least one slug
      // each entry must have a title field
      if (obj[1]['title'] === undefined || !obj[1]['slugs'] || obj[1]['slugs'].length < 1) {
        throw new Error('Invalid config: All entries must have a title field and at least one slug associated');
      }
    }
}

const publishCollections = async () => {
  // TODO: Path to config should be passed in from Git Action
  const config = yaml.load(fs.readFileSync('docs/config.yml', 'utf8')); 
  
  // validate config
  validateConfig(config);

  // set up log
  logger['collections'] = {};
  const log = logger['collections'];

  const collectionIds = Object.keys(config);
  const space = await client.getSpace(spaceId);
  const environ = await space.getEnvironment(envId);
  
  // update or create Collections
  for (let i = 0; i < collectionIds.length; i++) {
    const order = i;
    const collectId = collectionIds[i];
    const content = config[collectId];
    const refId = formatRefId(collectionIds[i], 'collection');
    try {
      const currCollection = await environ.getEntry(refId);
      await updateCollectionAndPublish(currCollection, order, content);
      log[collectId] = `Collection entry updated: ${currCollection.sys.id}`;
    } catch (err) {
      if (err.name === "NotFound") {
        const formatted = formatCollection(order, content);
        const newCollection = await environ.createEntryWithId('collection', refId, formatted);
        await newCollection.publish();
        log[collectId] = `Collection entry created: ${newCollection.sys.id}`;
      } else {
        log[collectId] = err;
      }
    }
  }
  // set up logger
  logger['collections']['pageOrder'] = {};
  const pageLog = logger['collections']['pageOrder'];
  
  // update Page entry orders based on collections content
  const pages = await environ.getEntries({
    "content_type": "page",
    "metadata.tags.sys.id[all]": getSourceTag(),
  });
  console.log('all pages here', pages);

  // get an array order of slugs
  let orderedSlugs = [];
  collectionIds.forEach(collectId => {
    const collectSlugs = config[collectId]['slugs'];
    orderedSlugs = orderedSlugs.concat(collectSlugs);
  })
  // update Page entry order field
  for (let order = 0; order < orderedSlugs.length; order++) {
    let pageEntryId = formatRefId(orderedSlugs[order]);
    try {
    const page = await environ.getEntry(pageEntryId);
      await setPageOrderAndPublish(page, order);
      pageLog[pageEntryId] = `${page.sys.id} order updated`;
    } catch (error) {
      pageLog[pageEntryId] = error;
    }
  }
}

// generates reference id that corresponds to Contentful entry id
const formatRefId = (id, entryType) => {
  let refId;
  /**
   * generates a ref id in the following format:
   * <org>_<repo>_<entrytype>_<slug>
   * */
  refId = `${process.env.REPOSITORY}_${entryType}_${id}`;
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
const formatPage = (path, frontMatter, body) => {
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
          "en-US": frontMatter['slug']
        },
        sha: {
          "en-US": process.env.SHA
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
  const match = /---[^-]+---/s.exec(data);
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

const updatePageAndPublish = async (page, frontMatter, body, path) => {
  if (!page || !frontMatter) {
    throw new Error ('Missing page entry or frontmatter');
  }
  let currLocale = getLocale(frontMatter['lang']);
  page.fields.title[currLocale] = frontMatter['title'];
  page.fields.author[currLocale] = [process.env.AUTHOR];
  page.fields.markdown[currLocale] = body;
  page.fields.source[currLocale] = `https://github.com/${process.env.REPOSITORY}/blob/main/${path}`;
  let updated = await page.update();
  await updated.publish();
}

// accepts an instance of Page (entry and updates its order)
const setPageOrderAndPublish = async (pageEntry, order) => {
  pageEntry.fields.order = {
    "en-US": order
  }
  let updated = await pageEntry.update();
  await updated.publish();
}

const createPageEntryAndPublish = async (path, frontMatter, body, refId, environ) => {
  const pageEntry = formatPage(path, frontMatter, body);
  const entry = await environ.createEntryWithId('page', refId, pageEntry);
  await entry.publish();
  return entry;
}

// primary function to create, update, entries
const publishPages = async () => {
  // set up log
  logger['pages'] = {};
  const log = logger['pages'];
  
  const fileContentStore = await getFileContent();
  const fPaths = Object.keys(fileContentStore);
  
  // process each file
  for (const path of fPaths) {
    const content = fileContentStore[path];
    const { frontMatter, body } = parse(content);
    const refId = formatRefId(frontMatter['slug'], 'page');
    const space = await client.getSpace(spaceId);
    const environ = await space.getEnvironment(envId);
    if (content !== null) {
      try {
        // updates existing entry
        validateFrontMatter(frontMatter);
        const entry = await environ.getEntry(refId);
        await updatePageAndPublish(entry, frontMatter, body, path);
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
    await updateTags();
    await publishPages();
    await publishCollections();
  } catch (error) {
    console.log('Error processing request', error);
  } finally {
    console.log(logger);
  }
}

publish();
/* 

October Sprint
- Fix regex that strips front matter
- Add Page links to Collections
- Add commit SHA as unique identifier for Pages + Collections
- Correct order field in Pages + Collections to number and make the source

Debrief Items
- Github Actions Publish + convert repos into consumer repos
- Handling asset upload to contentful (haven't dealt with this yet)
- Handling module subreference - Python
- Make logging better with summary stats for easy review and coded errors
- Tests!

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
    - If there are documentations to add in different supported languages, the supported languages need to be updated in the map. 
  - 
*/