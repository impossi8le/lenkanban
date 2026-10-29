import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
const state=vi.hoisted(()=>({replace:vi.fn(),link:vi.fn()}));
const router={replace:state.replace};
vi.mock("next/navigation",()=>({useRouter:()=>router}));
vi.mock("next/link",()=>({default:({href,prefetch,children,...rest}:{href:string;prefetch?:boolean;children:React.ReactNode})=>{state.link(prefetch);return <a href={href} {...rest}>{children}</a>;}}));
import { AuthorizedDepartmentRedirect } from "./AuthorizedDepartmentRedirect";
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("does not navigate during render and includes a normal fallback link to the authorized target",()=>{
 const href="/projects/bank/board?view=board&create=task";
 const html=renderToStaticMarkup(<AuthorizedDepartmentRedirect href={href}/>);
 expect(state.replace).not.toHaveBeenCalled();expect(html).toContain('role="status"');
 expect(html).toContain('href="/projects/bank/board?view=board&amp;create=task"');expect(state.link).toHaveBeenCalledWith(false);
});
it("replaces after commit and follows a changed server-authorized destination",()=>{
 const {rerender}=render(<AuthorizedDepartmentRedirect href="/projects/bank/board?view=board"/>);
 expect(state.replace).toHaveBeenCalledExactlyOnceWith("/projects/bank/board?view=board");
 expect(screen.getByRole("link",{name:"Открыть доску"})).toHaveAttribute("href","/projects/bank/board?view=board");
 rerender(<AuthorizedDepartmentRedirect href="/projects/support/board?view=board&create=task"/>);
 expect(state.replace).toHaveBeenCalledTimes(2);expect(state.replace).toHaveBeenLastCalledWith("/projects/support/board?view=board&create=task");
});
