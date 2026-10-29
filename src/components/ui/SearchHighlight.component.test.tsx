import {cleanup,render,screen} from "@testing-library/react";
import {afterEach,it,expect} from "vitest";
import {SearchHighlight,TaskSearchContext} from "./SearchHighlight";
afterEach(cleanup);
it("renders HTML-like content as literal text with safe marks",()=>{
 const text='<img src=x onerror="unsafe()"> Анна';const {container}=render(<SearchHighlight text={text} query="img Анна"/>);expect(container.textContent).toBe(text);expect(container.querySelector("img")).toBeNull();expect([...container.querySelectorAll("mark")].map(n=>n.textContent)).toEqual(["img","Анна"]);
});
it("labels a late description match and highlights every visible query word",()=>{
 const task={id:"id",title:"Счёт",description:"Служебное начало. ".repeat(40)+"Оплата от Альфа"};const {container}=render(<TaskSearchContext task={task} query="оплата Альфа"/>);expect(screen.getByText(/Описание:/)).toBeInTheDocument();expect([...container.querySelectorAll("mark")].map(n=>n.textContent)).toEqual(["Оплата","Альфа"]);expect(container.textContent!.length).toBeLessThan(230);
});
it("adds no context DOM when query is empty",()=>{const {container}=render(<TaskSearchContext task={{id:"id",title:"Тема",description:"Описание"}} query=""/>);expect(container).toBeEmptyDOMElement();});
