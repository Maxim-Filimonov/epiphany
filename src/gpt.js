import { ChatOpenAI } from "langchain/chat_models/openai";
import { HumanChatMessage, SystemChatMessage } from "langchain/schema";
// import { useFireproof, FireproofCtx } from '@fireproof/core/hooks/use-fireproof'
import { Fireproof, Index, Listener } from "@fireproof/core";
// import {
//   Fireproof,
//   Index,
//   Listener,
// } from "../../fireproof/packages/fireproof/";

const TEMPERATURE = 0.2;

// class HumanChatMessage {}
// class SystemChatMessage {}

// class ChatOpenAI {
//   call() {
//     return {
//       text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, \nsed do eiusmod tempor incididunt ut \nlabore et dolore magna aliqua",
//     };
//   }
// }

export class Discovery {
  constructor() {
    // this should useContext or we should just useFireproof ...
    if (window.fireproof) {
      this.db = window.fireproof;
    } else {
      this.db = Fireproof.storage("epiphany");
      window.fireproof = this.db;
    }
    // only the fields for the home page
    this.typeIndex = new Index(this.db, (doc, map) => {
      map(doc.type, {
        _id: doc._id,
        interviewSummary: doc.interviewSummary || null,
        description: doc.description || null,
        didInterview: doc.conversations ? doc.conversations.length > 0 : false,
      });
    });
    this.listener = new Listener(this.db);
    this.doc = { _id: "discovery", product: "", customer: "", openAIKey: "" };
    this.hydro = false;
    this.personas = [];
  }

  async registerChangeHandler(fn) {
    if (this.unlisten) this.unlisten();
    this.unlisten = this.listener.on("*", async () => {
      // await this.rehydrate();
      fn();
    });
  }

  async rehydrate(page) {
    this.hydro = true;
    // load personas from fireproof
    this.personas = await this.loadPersonas(page);
    this.doc = await this.db
      .get("discovery")
      .catch((e) => ({ _id: "discovery" }));
  }

  async loadPersonas(page) {
    // console.log("do query");
    const res = await this.typeIndex.query({ key: "persona" });
    // console.log("personas", res.rows);
    return await Promise.all(
      res.rows.map(async (r) => {
        if (page !== "home") {
          const doc = await this.db.get(r.id);
          return Persona.fromDoc(doc, this.db);
        } else {
          // no conversations on home page
          return Persona.fromDoc(r.value, this.db);
        }
      })
    );
  }

  async resetPersonas() {
    const res = await this.typeIndex.query({ key: "persona" });
    this.personas = [];
    await Promise.all(res.rows.map(async (r) => this.db.del(r.value._id)));
  }

  async personaById(id) {
    const doc = await this.db.get(id);
    return Persona.fromDoc(doc, this.db);
  }

  async askFollowUps() {
    this.personas = await this.loadPersonas();
    return await Promise.all(
      this.personas.map(async (p) => await p.askFollowUps(this.doc.followUps))
    );
  }

  bigInterviewer() {
    if (this.interviewer) return this.interviewer;
    const api = new ChatOpenAI({
      temperature: TEMPERATURE,
      openAIApiKey: this.doc.openAIKey,
    });
    this.interviewer = {
      call: async (msgs) => {
        const res = api.call(msgs);
        return res;
      },
    };
    return this.interviewer;
  }

  async generateCustomers(product, customer, openAIKey) {
    this.doc.product = product;
    this.doc.customer = customer;
    this.doc.openAIKey = openAIKey;
    await this.db.put(this.doc);

    const gptPeople = await this.bigInterviewer().call([
      new SystemChatMessage(
        `You have read The Four Steps to the Epiphany by Steven Gary Blank and you are ready to
        start your first customer interview. You will help gather people to interview and then interview them.
        This is the product you are building: ${product}. The customer you are building for is: ${customer}.`
      ),
      new HumanChatMessage(
        `Based on the product and customer descriptions, give a list of five people that would be interested 
          in this product. Give them memorable names and relevant descriptions. Your output should be in the
          form of a newline-delimited list, with each line looking like \`Talkative Tom: a frontend 
          designer who is always telling his peers about new cool demos on CodePen.\`
          `
      ),
    ]);

    const people = gptPeople.text.split("\n");

    for (const person of people) {
      if (!person) continue;
      if (/^\s*$/.test(person)) continue;
      if (!/[-:]/.test(person)) {
        console.log("need to parse", person);
        continue;
      }
      // consoloe.log("person", person);
      const persona = new Persona(person, this.doc, this.db);
      await persona.persist();
      this.personas.push(persona);
    }
  }

  async generateInterviewSummary() {
    this.loadPersonas()
    const summary = await this.bigInterviewer().call([
      new SystemChatMessage(
        `Now that you have interviewed your customers, you have a lot of information. Here are the interview summaries
        for each of your personas: ${JSON.stringify(this.personas.map(p => p.interviewSummary))}`
      ),
      new HumanChatMessage(
        "Summarize your conversations, highlighting the customers, use-cases, and features that have the most commercial viability."
      ),
    ]);
    this.doc.interviewSummary = summary.text;
    await this.db.put(this.doc);
    const followUps = await this.bigInterviewer().call([
      new HumanChatMessage(
        `Based on this summary ${summary.text}, what are the top 3 questions we should ask the next customer we interview, 
        in an effort to discover the most compelling ways customers like ${this.doc.customer} could use ${this.doc.product}?`
      ),
    ]);
    this.doc.followUps = followUps.text;
    await this.db.put(this.doc);
  }
}

export class Persona {
  static docFields =
    "openAIKey description product customer conversations perspective followUpsAnswer interviewSummary didInterview";

  perspective = "";
  constructor(description, { product, customer, openAIKey }, db) {
    this.openAIKey = openAIKey;
    this.description = description;
    this.didAsk = false;
    this.conversations = [];
    this.product = product;
    this.customer = customer;
    this.id = null;
    this.db = db;
  }

  myChat() {
    if (this.chat) return this.chat;
    const api = new ChatOpenAI({
      temperature: TEMPERATURE,
      openAIApiKey: this.openAIKey,
    });
    this.chat = {
      call: async (msgs) => {
        const res = api.call(msgs);
        return res;
      },
    };
    return this.chat;
  }

  myInterviewer() {
    if (this.interviewer) return this.interviewer;
    const api = new ChatOpenAI({
      temperature: TEMPERATURE,
      openAIApiKey: this.openAIKey,
    });
    this.interviewer = {
      call: async (msgs) => {
        const res = api.call(msgs);
        return res;
      },
    };
    return this.interviewer;
  }

  displayName() {
    const match = this.description?.match(/(.*?)[:]/);
    // console.log('match', match, this.description)
    return match && match[1];
  }

  displayAbout() {
    // console.log(this.description)
    return this.description?.match(/[:](.*)/)[1];
  }

  hasInterviewed() {
    return this.conversations
      ? this.conversations.length > 0
      : this.didInterview;
  }

  static fromDoc(doc, db) {
    const persona = new Persona(null, doc, db);
    Persona.docFields
      .split(" ")
      .forEach((field) => (persona[field] = doc[field]));
    persona.id = doc._id;
    return persona;
  }

  async persist() {
    const doc = { type: "persona" };
    if (this.id) {
      doc._id = this.id;
    }
    Persona.docFields.split(" ").forEach((field) => {
      if (this[field]) {
        doc[field] = this[field];
      }
    });
    // console.log('persist', doc)
    // if (doc.description)
    const resp = await this.db.put(doc);
    // console.log('resp', resp)

    this.id = resp.id;
  }

  async askFollowUps(followups) {
    const qAnswer = await this.myChat().call([new HumanChatMessage(followups)]);
    this.followUpsAnswer = qAnswer.text;
    await this.persist(this.db);
  }

  async doInterview() {
    this.conversations = []; // reset
    await this.pursueQuestions(
      "What are the biggest problems a product like this could help you solve?"
    );
    await this.pursueQuestions(
      "How much do these problem cost you in money and time?"
    );
    await this.pursueQuestions("What other solutions are you considering?");
    await this.pursueQuestions(
      "If you could wave a magic wand and change anything about this, what would you do?"
    );
  }

  async pursueQuestions(question, thisConvo = null, rounds = 3) {
    if (rounds < 1) return;
    if (!thisConvo) {
      thisConvo = [];
      this.conversations.push(thisConvo);
    }
    const messages = [];
    if (!this.didAsk) {
      messages.push(
        new SystemChatMessage(
          `You will act in a dialog as ${
            this.description
          }. We will interview you about ${this.product} 
          designed for someone like ${this.customer}. You have a perspective ${
            this.perspective
          }.
          It is crucial that you stay in character as ${this.displayName()}, so don't say you are an AI model,
          pretend to play along in the dialog. When the interviewer addesses "you" remember that they are talking
          to ${this.displayName()} and answer convincingly.`
        )
      );
      this.didAsk = true;
    }
    messages.push(
      new SystemChatMessage(`Here is the next question from the human. 
    Remember to stay in character as ${this.displayName()}. You don't need to say 
    "As an AI language model, I do not have ..." because the tool is well-labelled with AI disclaimers.
    Just answer the question as if you were ${this.displayName()}. Remember that when the interviewer 
    says "you" they are talking to ${this.displayName()}.`)
    );
    messages.push(new HumanChatMessage(question));

    thisConvo.push({ by: "interviewer", text: question });
    await this.persist(this.db);

    const qAnswer = await this.myChat().call(messages);

    thisConvo.push({ by: "persona", text: qAnswer.text });
    await this.persist(this.db);

    const furtherQuestions = await this.myInterviewer().call([
      new SystemChatMessage(
        `Here is the response from ${this.description} to the question: ${question}. What should we ask them next?`
      ),
      new HumanChatMessage(qAnswer.text),
    ]);
    return this.pursueQuestions(furtherQuestions.text, thisConvo, rounds - 1);
  }

  async summarizeInterview() {
    // console.log(JSON.stringify(this.conversations));
    const qAnswer = await this.myChat().call([
      new SystemChatMessage(
        `Summarize the interview for another instance of ChatGPT, target summary length is 1000 words.
        Here is the interview text as a reminder: ${JSON.stringify(
          this.conversations
        )}`
      ),
      // new SystemChatMessage(
      //   //   `Your interview is complete, the interviewer will now ask for a summary. Here is the interview text as a reminder: ${JSON.stringify(
      //   //     this.conversations
      //   //   )}`
      //   // ),
      //   // new HumanChatMessage(
      //   //   "Provide a list of the most important problems Fireproof can solve for you, and the impact the soltuion would have."
      //   // ),
    ]);
    this.interviewSummary = qAnswer.text;
    await this.persist();
  }
}

// now GPT interviews the human

//   const product = await ux.prompt('What is the quick elevator pitch for your product.')
//   const customer = await ux.prompt('Please describe your most clearly understood customer or initial user.')
//   const channel = await ux.prompt('What is the primary channel through which you will reach your customer?')
//   const pricing = await ux.prompt('What is the pricing model for your product?')
//   const problem = await ux.prompt('What is the problem that your customer is trying to solve?')
//   const dayInLife = await ux.prompt('What is a typical day in the life of your customer?')
//   const buyerMapPeople = await ux.prompt('Who are the people that influence the buying decision?')
//   const roiJustification = await ux.prompt('What is the ROI justification for your product?')
//   const buyingHabits = await ux.prompt('What are the buying habits of your customer? What channels to the puchase through?')
