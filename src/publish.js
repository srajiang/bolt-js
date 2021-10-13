/* 
  This script is triggered by github actions workflow and is responsible for
  publishing documentation updates to contentful cms
 */
import contentful from 'contentful-management';
import fs from 'fs';
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
const getPaths = () => {
  return process.env.FILES_CHANGED
  .split(' ') 
  .filter(str => /^docs\/.*/.test(str)); 
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
  const changedPaths = getPaths();
  let contentStore;
  if (changedPaths.length !== 0) {
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

// TODO: update page manifest
const validateAndUpdateManifest = async (changedFiles, allFiles) => {
  // There is a manifest file. If not, error

  // If manifest file is changed
    // Validate that every file listed in the manifest also exists in FS. If not, error
    // update the manifest with the new manifest
  
  // If manifest file is unchanged
    // Confirm every file in listed in manifest also exists in fs. If not, error  
}

// generates a reference id that corresponds to Contentful entry id
const formatRefId = (frontMatter) => {
  let refId;
  /**
   * generates a ref id in the following format:
   * <org>_<repo>_<slug>
   * */
  refId = `${process.env.REPOSITORY}_${frontMatter.slug}`;
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
    tokens: lexed,
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
  let missing = getMissingFields(frontMatter);
  if (missing.length > 0) {
    throw new Error('Missing required field(s)', missing);
  }
}

// checks that a uuid exists and is being added
const validateUUID = (entry, frontMatter) => {
  let localizedUUID = entry.fields.uuid ? entry.fields.uuid[currLocale]: null;
  console.log('entry uuid is: ', localizedUUID);
  // provided uuid does not matching existing uuid field in the entry
  if (localizedUUID && localizedUUID !== frontMatter['uuid']) {
   throw new Error('Trying to update entry whose uuid does not match provided uuid') 
  } 
  // no uuid in existing entry and no uuid 
  // TODO: Enable these lines
  // if (!localizedUUID && (!frontMatter['uuid'] || !frontMatter['uuid' === ''])) {
  //   throw new Error('Please provide a uuid in the front matter')
  // }
}

const updateEntry = async (entry, frontMatter, body) => {
  if (!entry || !frontMatter) {
    throw new Error ('Missing entry or frontmatter');
  }
  let currLocale = getLocale(frontMatter['lang']);
  entry.fields.title[currLocale] = frontMatter['title'];
  entry.fields.author[currLocale] = [process.env.AUTHOR];
  entry.fields.markdown[currLocale] = body;
  entry.fields.source[currLocale] = `https://github.com/${process.env.REPOSITORY}/blob/main/${path}`;
  entry.fields.uuid[currLocale] = frontMatter['uuid'];
  await entry.update();
}

// primary function to create, update, entries
const publishToCms = async () => {
  const fileContentStore = await getFileContent();
  const fPaths = Object.keys(fileContentStore);
  const log = {};
  
  // process each file
  for (const path of fPaths) {
    const content = fileContentStore[path];
    const { frontMatter, body } = parse(content);
    const refId = formatRefId(frontMatter);
    const space = await client.getSpace(spaceId);
    const environ = await space.getEnvironment(envId);

    // for update a file must have content
    if (content !== null) {
      try {
        // updates existing entry
        validateFrontMatter(frontMatter);
        const entry = await environ.getEntry(refId);
        validateUUID(entry, frontMatter);
        const updated = await updateEntry(entry, frontMatter, body);
        // TODO: Temp logger
        log[path] = `Entry updated: ${updated.sys.id}`;
      } catch (err) {
        if (err.name === "NotFound") {
          // create a new entry
          const pageEntry = getPageEntry(path, frontMatter, body);
          try {
            const entry = await environ.createEntryWithId('page', refId, pageEntry);
            log[path] = `Entry created: ${entry.sys.id}`;
            await entry.publish();
          } catch (error) {
            log[path] = error;
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
    await updateTags();
    await publishToCms();
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
- can update Author(s) field with the full list of authors 
- Includes a tag field with the repo ✅
- More robust front matter handling ✅ 
- Could handle asset upload to contentful? 
- Make activity logging accessible to other github actions

Docs
- All docs are required to have frontmatter: at least lang, title, slug (must be unique) in the proper format
- Order is not required ❗
- Slugs
  - Slugs should use - not _ e.g. listening-messages ❗
  - Slugs must be unique (excepting localized versions. These must always match in order) 
    for articles in other languages to be associated properly). 
  - Once a slug has been established, it should not be updated. Updating a slug will break links
  - Slugs should also serve as the unique reference for the entry 
- Making a change
  - Changing the name of a article, - update the title field (should match the filename)

Migration requirements
Handling failures
- If update or creation or deletion fails, check the log

Creating and persist a unique id based on slug provided
- Every unique file has a refid (can collide) AND a uuid (cannot collide).
    - Files and refId are in possible many to one relationship. Example, eng and ja language files share a refId and 
    - live together under 1 entry as localized versions in Contentful. 
    - Files and uuid are in a one-to-one relationship. Those same Eng and ja lang files each have different uuids
    - Contentful -> Inside ref:authorization, a uuid's field contains a list of associated files e.g. ['uuid:auth_ja_dateCreated', uuid:'auth_ja_dateCreated']
    - Github docs -> Inside file, record will also contain it's own UUID (directly inline)

- A list of files that will either have or NOT have content associated
    - has content?
      - A user has updated or added a file in github
        - Update is to content -> no issues, use the ref id and simply update based on file's locale
        - Update is to frontmatter -> 
          - Title updated -> No issues
          - Lang updated -> If not an supported lang, error
                        -> If a supported lang (jp -> eng), would update the wrong version of the content. That should be caught in review.
          - Slug updated -> Leads to a different reference id -> Creates a new entry entirely (this should be caught in review)    
          - UUID (uuids 1:1 with files)
            - If there's NOT already a UUID
            -   Gen a new UUID (containing date in mis)
            -   Put in entry.uuids in the entry
            -   Update own file with UUID 
    - does not have content? 
      - A user has deleted a file in Github or renamed an existing file
        - Get the last previous commit that affected the file that is not current
        - Checkout the version at the commit where the file was LAST edited
        - Get its refId (based on the slug)
        - Fetch entry associated with its refId from Contentful
          - Update uuids reference: Remove its uuid from the uuids array in the Entry
  
- Notes 
    - Anytime there are new documentations to add in different supported languages, the supported languages need to be updated

*/