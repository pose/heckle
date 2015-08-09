#!/usr/bin/env node

var path = require("path");
var fs = require("fs");
var rmrf = require("rimraf");
var yaml = require("js-yaml");
var Mold = require("mold-template");
var util = require("./util");
var Handlebars = require('handlebars');

/**
 * @param contents
 *        A string containing the file contents.
 * @return
 *        An object with the properties `frontMatter` and `mainText`,
 *        representing the file front matter and a string containing the
 *        remainder of the file, respectively.  `frontMatter` will be null if
 *        the file contains no front matter block, otherwise the block's YAML
 *        properties will be available as JS properties.
 */
function readContents(contents) {
  if (/^---\n/.test(contents)) {
    var end = contents.search(/\n---\n/);
    if (end != -1)
      return {
        frontMatter: yaml.load(contents.slice(4, end + 1)) || {},
        mainText: contents.slice(end + 5)
      };
  }
  return {frontMatter: null, mainText: contents};
}

let renderMarkdown = null;

function getRenderMarkdown(config) {
  return require(config.markdownRenderer ? path.resolve(process.cwd(), config.markdownRenderer) : "./markdownRenderer");
}

function readPosts(config) {
  var postsDir = "_posts/";
  var posts = [];
  if (!fs.existsSync(postsDir)) return posts;
  fs.readdirSync(postsDir).forEach(function(file) {
    var d = file.match(/^(\d{4})-(\d\d?)-(\d\d?)-(.+)\.(md|markdown|link|html)$/);
    if (!d) return;
    var contents = readContents(fs.readFileSync(postsDir + file, "utf8"));
    var post = contents.frontMatter || {};
    post.date = new Date(d[1], d[2] - 1, d[3]);
    post.name = d[4];
    if (!post.tags) post.tags = [];
    if (!post.tags.forEach && post.tags.split) post.tags = post.tags.split(/\s+/);
    var extension = d[5];
    if (extension == "link") {
      var escd = Mold.prototype.escapeHTML(post.url);
      post.content = "<p>Read this post at <a href=\"" + escd + "\">" + escd + "</a>.</p>";
      post.isLink = true;
    } else {
      post.content = (extension == "md" || extension == "markdown") ?
        renderMarkdown(contents.mainText) :
        contents.mainText;
      post.url = getURL(config, post);
    }
    posts.push(post);
  });
  posts.sort(function(a, b){return b.date - a.date;});
  return posts;
}

function gatherTags(posts) {
  var tags = {};
  posts.forEach(function(post) {
    if (post.tags) post.tags.forEach(function(tag) {
      (tags.hasOwnProperty(tag) ? tags[tag] : (tags[tag] = [])).push(post);
    });
    else post.tags = [];
  });
  return tags;
}

var defaults = {
  postLink: "${name}.html",
  postFileName: "${url}"
};

function readConfig() {
  var config = (util.exists("_config.yml") && yaml.load(fs.readFileSync("_config.yml", "utf8"))) || {};
  for (var opt in defaults) if (defaults.hasOwnProperty(opt) && !config.hasOwnProperty(opt))
    config[opt] = defaults[opt];
  return config;
}

function fillTemplate(tpl, vars) {
  for (var prop in vars) tpl = tpl.replace("${" + prop + "}", vars[prop]);
  return tpl;
}

function getURL(config, post) {
  return fillTemplate(config.postLink, post);
}

function ensureDirectories(path) {
  var parts = path.split("/"), cur = "";
  for (var i = 0; i < parts.length - 1; ++i) {
    cur += parts[i] + "/";
    if (!util.exists(cur, true)) fs.mkdirSync(cur);
  }
}

function prepareMold(ctx) {
  var mold = new Mold(ctx)
  if (util.exists("_includes/", true))
    fs.readdirSync("_includes/").forEach(function(file) {
      mold.bake(file.match(/^(.*?)\.[^\.]+$/)[1], fs.readFileSync("_includes/" + file, "utf8"));
    });
  return mold
}

function partialTemplate(tmpl, ctx) {
  return function (newCtx) {
    var finalCtx = JSON.parse(JSON.stringify(ctx));
    Object.keys(newCtx).forEach(function (key) {
      finalCtx[key] = newCtx[key];
    });
    return tmpl(finalCtx);
  };
}

function prepareIncludes(ctx) {
  if (!util.exists("_includes/", true)) return;
  fs.readdirSync("_includes/").forEach(function(file) {
    var includeName = file.match(/^(.*?)\.[^\.]+$/)[1];
    Handlebars.registerPartial(includeName, fs.readFileSync("_includes/" + file, "utf8"));
  });
}

var layouts = {};
function getLayout(name, mold) {
  if (name.indexOf(".") == -1) name = name + ".html";
  if (layouts.hasOwnProperty(name)) return layouts[name];
  var tmpl = Handlebars.compile(fs.readFileSync("_layouts/" + name, "utf8"));

  var mergedTmpl = partialTemplate(tmpl, ctx);

  mergedTmpl.filename = name;
  layouts[name] = mergedTmpl;

  return mergedTmpl;
}

function generate() {
  var config = readConfig();
  renderMarkdown = getRenderMarkdown(config);
  var posts = readPosts(config);
  var ctx = {site: {posts: posts, tags: gatherTags(posts), config: config},
             dateFormat: require("dateformat")};
  var includes = prepareIncludes(ctx);
  if (util.exists("_site", true)) rmrf.sync("_site");
  posts.forEach(function(post) {
    if (post.isLink) return;
    var path = "_site/" + fillTemplate(config.postFileName, post);
    ensureDirectories(path);
    fs.writeFileSync(path, getLayout(post.layout || "post.html", includes)(post), "utf8");
  });
  function isExcluded(path) {
    return (config.exclude || []).some(function (exclude) {
      return path.slice(2).indexOf(exclude) === 0;
    });
  }
  function walkDir(dir) {
    fs.readdirSync(dir).forEach(function(fname) {
      if (/^[_\.]/.test(fname)) return;
      var file = dir + fname;
      if (isExcluded(file)) return;
      if (fs.statSync(file).isDirectory()) {
        walkDir(file + "/");
      } else {
        var out = "_site/" + file;
        ensureDirectories(out);
        var contents = readContents(fs.readFileSync(file, "utf8"));
        if (contents.frontMatter) {
          var doc = contents.frontMatter;
          var layout = getLayout(doc.layout || "default.html", includes);
          doc.content = /\.(md|markdown)$/.test(fname) ?
            renderMarkdown(contents.mainText) :
            contents.mainText;
          doc.name = fname.match(/^(.*?)\.[^\.]+$/)[1];
          doc.url = file;
          out = out.replace(/\.(md|markdown)$/, layout.filename.match(/(\.\w+|)$/)[1]);
          fs.writeFileSync(out, layout(doc), "utf8");
        } else {
          util.copyFileSync(file, out);
        }
      }
    });
  }
  walkDir("./");
}

generate();
