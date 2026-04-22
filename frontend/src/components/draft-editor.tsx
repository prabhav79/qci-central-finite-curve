"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Button } from "@/components/ui/button";
import { 
  Bold, 
  Italic, 
  Heading1, 
  Heading2, 
  List, 
  ListOrdered,
  Save,
  X,
  History
} from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const ToolbarButton = ({ 
  onClick, 
  active, 
  disabled, 
  children 
}: { 
  onClick: () => void; 
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) => (
  <Button
    type="button"
    variant="ghost"
    size="icon"
    className={cn(
      "h-8 w-8 hover:bg-white/10 transition-colors",
      active ? "bg-primary text-primary-foreground hover:bg-primary/90" : "text-muted-foreground"
    )}
    onClick={onClick}
    disabled={disabled}
  >
    {children}
  </Button>
);

export function DraftEditor({ 
  content, 
  onSave, 
  onClose 
}: { 
  content: string; 
  onSave: (editedContent: string) => void;
  onClose: () => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "Start typing document content...",
      }),
    ],
    content,
    editorProps: {
      attributes: {
        class: "prose prose-invert prose-sm sm:prose-base max-w-none focus:outline-none min-h-[400px] p-8",
      },
    },
  });

  if (!editor) return null;

  return (
    <div className="glass border-white/10 rounded-2xl overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
      <div className="bg-primary/5 p-2 flex items-center justify-between border-b border-white/10">
        <div className="flex items-center gap-1 px-2">
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive("bold")}
          >
            <Bold size={16} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive("italic")}
          >
            <Italic size={16} />
          </ToolbarButton>
          <Separator orientation="vertical" className="h-6 mx-1 bg-white/10" />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            active={editor.isActive("heading", { level: 1 })}
          >
            <Heading1 size={16} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            active={editor.isActive("heading", { level: 2 })}
          >
            <Heading2 size={16} />
          </ToolbarButton>
          <Separator orientation="vertical" className="h-6 mx-1 bg-white/10" />
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            active={editor.isActive("bulletList")}
          >
            <List size={16} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            active={editor.isActive("orderedList")}
          >
            <ListOrdered size={16} />
          </ToolbarButton>
        </div>

        <div className="flex items-center gap-2 pr-2">
          <Button variant="ghost" size="sm" className="h-8 text-[11px] gap-2 uppercase tracking-wider font-bold" onClick={onClose}>
            <X size={14} />
            Discard
          </Button>
          <Button size="sm" className="h-8 text-[11px] gap-2 uppercase tracking-wider font-bold" onClick={() => onSave(editor.getHTML())}>
            <Save size={14} />
            Save Changes
          </Button>
        </div>
      </div>

      <div className="bg-card/40 min-h-[500px]">
         <EditorContent editor={editor} />
      </div>

      <div className="bg-primary/5 p-3 px-6 border-t border-white/10 flex items-center justify-between text-[10px] uppercase font-bold tracking-widest text-muted-foreground/60">
        <div className="flex items-center gap-2">
           <History size={12} />
           Unsaved Changes
        </div>
        <div>
           {editor.storage.characterCount?.characters() || 0} characters
        </div>
      </div>
    </div>
  );
}
